import { App, Notice, TAbstractFile, TFile, TFolder, requestUrl } from "obsidian";
import type { MySyncSettings } from "../settings";
import type {
	CouchDbConnection,
	FileRevisionState,
	PouchDbFileStore
} from "./pouchdb-store";
import type { PouchDbConflictStore } from "./conflict-store";
import type {
	ConflictResolutionStrategy,
	SyncConflict,
	SyncConflictKind,
	SyncConflictLocalVariant,
	VaultFileRecord
} from "./types";
import {
	collectSyncableFilesInFolder,
	createAdapterFileContentHash,
	createBinaryContentHash,
	createFileRecord,
	createFileRecordId,
	createLocalFileContentHash,
	createObsidianConfigFileRecord,
	createTextContentHash,
	getPathFromFileRecordId,
	getSyncFolder,
	getSyncFolderState,
	isFileInsideSyncFolder,
	isSyncBlacklistedPath,
	isObsidianConfigFilePath,
	isSyncableVaultFile,
	isPathInsideSyncFolder,
	listObsidianConfigFilePaths
} from "./vault-files";
import { Logger } from "../utils/logger";

interface LocalSyncResult {
	total: number;
	saved: number;
	skipped: number;
}

interface RestoreResult {
	total: number;
	restored: number;
	skipped: number;
	conflicts: number;
	configurationChanged: boolean;
}

interface RemoteDeletionResult {
	total: number;
	deleted: number;
	skipped: number;
	conflicts: number;
	configurationChanged: boolean;
}

interface PullClassification {
	deletedRecordIds: string[];
	conflictedRecordIds: Set<string>;
}

export interface EmptyFolderCleanupResult {
	total: number;
	removed: number;
	skipped: number;
}

export type SyncStatus =
	| { state: "idle" }
	| { state: "queued"; pending: number }
	| { state: "syncing"; current: number; total: number; saved: number; skipped: number }
	| { state: "done"; total: number; saved: number; skipped: number }
	| { state: "pushing"; docsWritten: number }
	| { state: "pushed"; docsWritten: number }
	| { state: "pulling"; docsRead: number }
	| { state: "deleting"; current: number; total: number; deleted: number; skipped: number; conflicts: number }
	| { state: "restoring"; current: number; total: number; restored: number; skipped: number; conflicts: number }
	| { state: "pulled"; docsRead: number; restored: number; deleted: number; skipped: number; conflicts: number }
	| { state: "cleaning-empty-folders"; current: number; total: number; removed: number; skipped: number }
	| { state: "empty-folders-cleaned"; removed: number; skipped: number }
	| { state: "resetting-local-databases" }
	| { state: "local-databases-reset" }
	| { state: "testing" }
	| { state: "tested"; databaseName: string; documentCount?: number }
	| { state: "error"; message: string };

export type CompletedSyncOperation =
	| "syncNow"
	| "pushToCouchDb"
	| "pullFromCouchDb"
	| "resetLocalDatabases";

const logger = new Logger("SyncService");
const SYNCED_OBSIDIAN_CONFIGURATION_FILE_NAMES = new Set([
	"app.json",
	"hotkeys.json",
	"workspace.json"
]);

function isSyncedObsidianConfigurationFilePath(
	app: App,
	path: string,
	syncEnabled = true
) {
	if (!syncEnabled || !isObsidianConfigFilePath(app, path)) {
		return false;
	}

	const fileName = path.slice(path.lastIndexOf("/") + 1);
	return SYNCED_OBSIDIAN_CONFIGURATION_FILE_NAMES.has(fileName);
}

function isExcludedObsidianConfigurationFilePath(
	app: App,
	path: string,
	syncEnabled = true
) {
	return isObsidianConfigFilePath(app, path)
		&& !isSyncedObsidianConfigurationFilePath(app, path, syncEnabled);
}

export class SyncService {
	private syncInProgress = false;
	private pendingSyncPaths = new Set<string>();
	private syncQueueTimer: number | null = null;
	private applyingRemoteChange = false;
	private conflictedPaths = new Set<string>();

	constructor(
		private app: App,
		private localStore: PouchDbFileStore,
		private conflictStore: PouchDbConflictStore,
		private getSettings: () => MySyncSettings,
		private onStatusChange: (status: SyncStatus) => void,
		private onOperationCompleted: (operation: CompletedSyncOperation) => Promise<void>,
		private onConflictsChanged: (conflicts: SyncConflict[]) => void
	) {
		this.onStatusChange({ state: "idle" });
	}

	private isObsidianConfigSyncEnabled(): boolean {
		return this.getSettings().syncObsidianConfig;
	}

	private isSyncedObsidianConfigurationFilePath(path: string): boolean {
		return isSyncedObsidianConfigurationFilePath(
			this.app,
			path,
			this.isObsidianConfigSyncEnabled()
		);
	}

	private isExcludedObsidianConfigurationFilePath(path: string): boolean {
		return isExcludedObsidianConfigurationFilePath(
			this.app,
			path,
			this.isObsidianConfigSyncEnabled()
		);
	}

	async initialize() {
		await this.conflictStore.ensureDatabaseExists();
		await this.cleanupExcludedObsidianConfigurationRecords();
		await this.refreshActiveConflicts();
	}

	async listActiveConflicts() {
		return (await this.conflictStore.listActiveConflicts()).filter(
			(conflict) => !this.isExcludedObsidianConfigurationFilePath(conflict.path)
		);
	}

	async resolveConflict(
		conflictId: string,
		strategy: ConflictResolutionStrategy,
		selectedRevision?: string
	) {
		if (this.isRunning()) return;

		const settings = this.getSettings();
		const validationMessage = validateCouchDbSettings(settings, "resolving conflicts");

		if (validationMessage) {
			new Notice(validationMessage);
			return;
		}

		this.syncInProgress = true;
		let resolutionApplied = false;

		try {
			const conflict = await this.conflictStore.getConflict(conflictId);

			if (!conflict || conflict.status === "resolved") {
				throw new Error("Conflict is no longer available.");
			}

			await this.conflictStore.updateConflict(conflictId, (current) => ({
				...current,
				status: "resolving",
				error: undefined
			}));

			const [currentState] = await this.localStore.listFileRevisionStates([conflict.recordId]);
			const currentRevisions = currentState?.leaves.map((leaf) => leaf.revision).sort() ?? [];

			if (!arraysEqual(currentRevisions, conflict.observedLeafRevisions)) {
				await this.conflictStore.updateConflict(conflictId, (current) => ({
					...current,
					status: "stale",
					error: "The revision tree changed. Pull again before resolving this conflict."
				}));
				throw new Error("The conflict changed. Pull again to refresh it.");
			}

			const resolvedDocumentIds = await this.applyConflictResolution(
				conflict,
				strategy,
				selectedRevision
			);
			resolutionApplied = true;
			const resolvedAt = new Date().toISOString();

			await this.conflictStore.updateConflict(conflictId, (current) => ({
				...current,
				status: "pending-push",
				resolution: {
					strategy,
					selectedRevision,
					resolvedDocumentIds,
					resolvedAt
				},
				error: undefined
			}));

			await this.pushResolvedConflict(createCouchDbConnection(settings), resolvedDocumentIds);
			await this.conflictStore.updateConflict(conflictId, (current) => ({
				...current,
				status: "resolved",
				error: undefined
			}));
			await this.refreshActiveConflicts();
			new Notice(`Resolved conflict for ${conflict.path}.`);
		} catch (error) {
			logger.error("Conflict resolution failed", error, { conflictId, strategy });

			try {
				if (resolutionApplied) {
					await this.conflictStore.updateConflict(conflictId, (current) => ({
						...current,
						status: "pending-push",
						error: getErrorMessage(error, "Failed to push conflict resolution.")
					}));
				} else {
					await this.conflictStore.updateConflict(conflictId, (current) => ({
						...current,
						status: current.status === "stale" ? "stale" : "error",
						error: getErrorMessage(error, "Conflict resolution failed.")
					}));
				}
			} catch (updateError) {
				logger.error("Failed to persist conflict resolution error", updateError, { conflictId });
			}

			await this.refreshActiveConflicts();
			new Notice(getErrorMessage(error, "Conflict resolution failed."));
		} finally {
			this.syncInProgress = false;
			this.scheduleQueuedSync();
		}
	}

	async retryConflictPush(conflictId: string) {
		if (this.isRunning()) return;

		const conflict = await this.conflictStore.getConflict(conflictId);

		if (!conflict?.resolution || conflict.status !== "pending-push") {
			new Notice("This conflict has no resolution waiting to be pushed.");
			return;
		}

		const settings = this.getSettings();
		const validationMessage = validateCouchDbSettings(settings, "pushing the resolution");

		if (validationMessage) {
			new Notice(validationMessage);
			return;
		}

		this.syncInProgress = true;

		try {
			await this.pushResolvedConflict(
				createCouchDbConnection(settings),
				conflict.resolution.resolvedDocumentIds
			);
			await this.conflictStore.updateConflict(conflictId, (current) => ({
				...current,
				status: "resolved",
				error: undefined
			}));
			await this.refreshActiveConflicts();
			new Notice(`Pushed conflict resolution for ${conflict.path}.`);
		} catch (error) {
			logger.error("Conflict resolution push retry failed", error, { conflictId });
			await this.conflictStore.updateConflict(conflictId, (current) => ({
				...current,
				error: getErrorMessage(error, "Failed to push conflict resolution.")
			}));
			new Notice(getErrorMessage(error, "Failed to push conflict resolution."));
		} finally {
			this.syncInProgress = false;
		}
	}

	private async applyConflictResolution(
		conflict: SyncConflict,
		strategy: ConflictResolutionStrategy,
		selectedRevision?: string
	) {
		this.applyingRemoteChange = true;

		try {
			if (strategy === "delete") {
				await this.deleteLocalFile(conflict.path);

				await this.localStore.resolveFileRecordAsDeleted(conflict.recordId);
				return [conflict.recordId];
			}

			if (strategy === "keep-local") {
				const localRecord = await this.createLocalRecord(conflict.path);

				if (!localRecord) {
					throw new Error(`Local file not found: ${conflict.path}`);
				}

				await this.localStore.resolveFileRecordWithContent(
					conflict.recordId,
					localRecord,
					this.getSettings().localVaultId,
					strategy
				);
				return [conflict.recordId];
			}

			const remoteRevision = selectedRevision
				?? conflict.remoteVariants.find((variant) => variant.winning && !variant.deleted)?.revision
				?? conflict.remoteVariants.find((variant) => !variant.deleted)?.revision;

			if (!remoteRevision) {
				throw new Error("No live revision is available for this resolution.");
			}

			const remoteRecord = await this.localStore.getFileRevision(conflict.recordId, remoteRevision);

			if (!remoteRecord) {
				throw new Error("The selected remote revision is no longer available.");
			}

			if (strategy === "keep-both") {
				const localRecord = await this.createLocalRecord(conflict.path);

				if (!localRecord) {
					throw new Error("Keep both requires an existing local file.");
				}

				const copyPath = await this.createConflictCopyPath(conflict.path);
				await this.writeRecordToVault(remoteRecord, copyPath);
				const copyRecord = await this.createLocalRecord(copyPath);

				if (!copyRecord) {
					throw new Error(`Failed to create conflict copy: ${copyPath}`);
				}

				await this.localStore.saveFileRecordIfChanged(copyRecord);
				await this.localStore.resolveFileRecordWithContent(
					conflict.recordId,
					localRecord,
					this.getSettings().localVaultId,
					strategy
				);
				return [conflict.recordId, copyRecord._id];
			}

			await this.writeRecordToVault(remoteRecord, conflict.path);
			await this.localStore.resolveFileRecordWithContent(
				conflict.recordId,
				remoteRecord,
				this.getSettings().localVaultId,
				strategy
			);
			return [conflict.recordId];
		} finally {
			this.applyingRemoteChange = false;
		}
	}

	private async pushResolvedConflict(connection: CouchDbConnection, documentIds: string[]) {
		await this.localStore.pushToCouchDb(
			connection,
			(docsWritten) => this.onStatusChange({ state: "pushing", docsWritten }),
			{ docIds: documentIds }
		);
	}

	private async writeRecordToVault(record: VaultFileRecord, path: string) {
		if (record.source === "obsidian-config" || isObsidianConfigFilePath(this.app, path)) {
			if (!isObsidianConfigFilePath(this.app, path)) {
				throw new Error(`Cannot restore configuration outside ${this.app.vault.configDir}: ${path}`);
			}

			const existing = await this.app.vault.adapter.stat(path);

			if (existing?.type === "folder") {
				throw new Error(`Cannot restore ${path}: the path is not a file.`);
			}

			const data = await getAttachmentArrayBuffer(record);

			if (!data) {
				throw new Error(`Configuration content is unavailable for ${path}.`);
			}

			await this.app.vault.adapter.writeBinary(path, data);
			return;
		}

		const existing = this.app.vault.getAbstractFileByPath(path);

		if (existing && !(existing instanceof TFile)) {
			throw new Error(`Cannot restore ${path}: the path is not a file.`);
		}

		if (!existing) {
			const folderStatus = await this.ensureParentFolders(path);

			if (folderStatus === "conflict") {
				throw new Error(`Cannot restore ${path}: a parent path is a file.`);
			}
		}

		const isText = record.fileType === "markdown" && typeof record.content === "string";

		if (existing instanceof TFile) {
			if (isText) {
				await this.app.vault.modify(existing, record.content!);
				return;
			}

			const data = await getAttachmentArrayBuffer(record);

			if (!data) {
				throw new Error(`Binary content is unavailable for ${path}.`);
			}

			await this.app.vault.modifyBinary(existing, data);
			return;
		}

		if (isText) {
			await this.app.vault.create(path, record.content!);
			return;
		}

		const data = await getAttachmentArrayBuffer(record);

		if (!data) {
			throw new Error(`Binary content is unavailable for ${path}.`);
		}

		await this.app.vault.createBinary(path, data);
	}

	private async createConflictCopyPath(path: string) {
		const slashIndex = path.lastIndexOf("/");
		const folder = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
		const fileName = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
		const dotIndex = fileName.lastIndexOf(".");
		const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
		const extension = dotIndex > 0 ? fileName.slice(dotIndex) : "";
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const candidateBase = `${folder}${baseName} conflict-${timestamp}`;
		let candidate = `${candidateBase}${extension}`;
		let suffix = 2;

		while (await this.localPathExists(candidate)) {
			candidate = `${candidateBase} ${suffix}${extension}`;
			suffix += 1;
		}

		return candidate;
	}

	private async refreshActiveConflicts() {
		const conflicts = (await this.conflictStore.listActiveConflicts()).filter(
			(conflict) => !this.isExcludedObsidianConfigurationFilePath(conflict.path)
		);
		this.conflictedPaths = new Set(conflicts.map((conflict) => conflict.path));
		this.onConflictsChanged(conflicts);
	}

	private blockPushForConflicts() {
		this.onStatusChange({
			state: "error",
			message: "Resolve sync conflicts before pushing"
		});
		new Notice(`Resolve ${this.conflictedPaths.size} MySync conflict(s) before pushing.`);
	}

	isRunning(): boolean {
		if (this.syncInProgress) new Notice("A sync process is already running.");
		return this.syncInProgress;
	}

	async resetLocalDatabases(): Promise<boolean> {
		if (this.isRunning()) {
			return false;
		}

		const previouslyPendingPaths = this.takePendingSyncPaths();
		this.syncInProgress = true;
		this.onStatusChange({ state: "resetting-local-databases" });

		try {
			logger.warn("Local database reset started");
			await this.localStore.reset();
			await this.conflictStore.reset();
			await this.refreshActiveConflicts();

			try {
				await this.onOperationCompleted("resetLocalDatabases");
			} catch (error) {
				logger.warn("Failed to save local database reset timestamp", error);
			}

			this.onStatusChange({ state: "local-databases-reset" });
			new Notice(
				"Local databases reset. Pull before pushing to an existing remote database."
			);
			logger.info("Local database reset completed");
			return true;
		} catch (error) {
			for (const path of previouslyPendingPaths) {
				this.pendingSyncPaths.add(path);
			}

			logger.error("Local database reset failed", error);
			this.onStatusChange({
				state: "error",
				message: "Local database reset failed"
			});
			new Notice(getErrorMessage(
				error,
				"Local database reset failed. Check the console for details."
			));
			return false;
		} finally {
			this.syncInProgress = false;
			this.scheduleQueuedSync();
		}
	}

	async syncNow() {
		if (this.isRunning()) return;

		this.syncInProgress = true;
		let failed = false;

		try {
			const result = await this.syncLocalFiles();
			this.onStatusChange({
				state: "done",
				total: result.total,
				saved: result.saved,
				skipped: result.skipped
			});
			await this.onOperationCompleted("syncNow");
		} catch (error) {
			failed = true;
			logger.error("Synchronization failed", error);
			this.onStatusChange({
				state: "error",
				message: "synchronization failed"
			});
			new Notice(getErrorMessage(error, "Synchronization failed. Check the console for details."));
		} finally {
			this.syncInProgress = false;
			this.scheduleQueuedSync();

			if (!failed) {
				this.refreshQueuedStatus();
			}
		}
	}

	async pushToCouchDb() {
		if (this.isRunning()) {
			logger.info("Push skipped because another sync operation is running");
			return;
		}

		const settings = this.getSettings();
		const validationMessage = validateCouchDbSettings(settings);

		if (validationMessage) {
			logger.warn("Push validation failed", undefined, {
				message: validationMessage
			});
			this.onStatusChange({
				state: "error",
				message: validationMessage
			});
			new Notice(validationMessage);
			return;
		}

		if (this.conflictedPaths.size > 0) {
			this.blockPushForConflicts();
			return;
		}

		this.syncInProgress = true;
		let failed = false;

		const notice = new Notice("Start pushing.", 0);
		try {
			logger.info("Push started", {
				database: settings.couchDbDatabase,
				hasUsername: settings.couchDbUsername.length > 0,
				hasPassword: settings.couchDbPassword.length > 0
			});

			const connection = createCouchDbConnection(settings);
			const canPush = await this.localStore.canPushToCouchDb(connection);

			if (!canPush) {
				failed = true;
				logger.warn("Push blocked because remote has records without local baseline", undefined, {
					database: connection.database
				});
				this.onStatusChange({
					state: "error",
					message: "Push blocked"
				});
				new Notice("Pull from remote before pushing to this non-empty database.");
				return;
			}

			await this.syncLocalFiles();
			logger.info("Local file sync before push completed", {
				database: connection.database
			});

			const pushResult = await this.localStore.pushToCouchDb(
				connection,
				(docsWritten) => {
					this.onStatusChange({
						state: "pushing",
						docsWritten
					});
				}
			);
			logger.info("store.pushToCouchDb completed", {
				database: connection.database,
				docsWritten: pushResult.docsWritten
			});

			this.onStatusChange({
				state: "pushed",
				docsWritten: pushResult.docsWritten
			});

			await this.localStore.markRemoteBaseline(connection);
			await this.onOperationCompleted("pushToCouchDb");

			new Notice(`Pushed ${pushResult.docsWritten} document(s).`);
		} catch (error) {
			notice.hide();
			failed = true;
			logger.error("Push failed", error);
			this.onStatusChange({
				state: "error",
				message: "Push failed"
			});
			new Notice(getErrorMessage(error, "Push failed. Check the console for details."));
		} finally {
			notice.hide();
			this.syncInProgress = false;
			this.scheduleQueuedSync();

			if (!failed) {
				this.refreshQueuedStatus();
			}
		}
	}

	async pushPendingFilesToCouchDb() {
		if (this.isRunning()) {
			logger.info("Pending files push skipped because another sync operation is running");
			return;
		}

		const settings = this.getSettings();
		const validationMessage = validateCouchDbSettings(settings);

		if (validationMessage) {
			this.onStatusChange({
				state: "error",
				message: validationMessage
			});
			new Notice(validationMessage);
			return;
		}

		if (this.conflictedPaths.size > 0) {
			this.blockPushForConflicts();
			return;
		}

		this.syncInProgress = true;
		let failed = false;
		const notice = new Notice("Pushing pending changes.", 0);
		let pendingPaths: string[] = [];

		try {
			const connection = createCouchDbConnection(settings);
			const syncFolder = this.getCurrentSyncFolder();
			const [hasLocalSyncBaseline, hasRemoteBaseline] = await Promise.all([
				this.localStore.hasLocalSyncBaseline(syncFolder),
				this.localStore.hasRemoteBaseline(connection)
			]);
			const blockingState = getPendingPushBlockingState(
				hasLocalSyncBaseline,
				hasRemoteBaseline
			);

			if (blockingState) {
				failed = true;
				this.onStatusChange({
					state: "error",
					message: blockingState.statusMessage
				});
				new Notice(blockingState.noticeMessage);
				return;
			}

			pendingPaths = this.takePendingSyncPaths();

			try {
				await this.syncFilePaths(pendingPaths);
				await this.syncObsidianConfigurationFiles();
			} catch (error) {
				for (const path of pendingPaths) {
					this.pendingSyncPaths.add(path);
				}
				throw error;
			}

			const pushResult = await this.localStore.pushToCouchDb(
				connection,
				(docsWritten) => {
					this.onStatusChange({
						state: "pushing",
						docsWritten
					});
				},
				{ pendingChangesOnly: true }
			);

			logger.info("Pending files push completed", {
				preparedPaths: pendingPaths.length,
				docsWritten: pushResult.docsWritten
			});

			this.onStatusChange({
				state: "pushed",
				docsWritten: pushResult.docsWritten
			});

			await this.onOperationCompleted("pushToCouchDb");
			new Notice(`Pushed ${pushResult.docsWritten} pending document(s).`);
		} catch (error) {
			failed = true;
			logger.error("Pending files push failed", error);
			this.onStatusChange({
				state: "error",
				message: "Pending files push failed"
			});
			new Notice(getErrorMessage(error, "Pending files push failed. Check the console for details."));
		} finally {
			notice.hide();
			this.syncInProgress = false;
			this.scheduleQueuedSync();

			if (!failed) {
				this.refreshQueuedStatus();
			}
		}
	}

	async pullFromCouchDb() {
		if (this.isRunning()) return;

		const settings = this.getSettings();
		const validationMessage = validateCouchDbSettings(settings, "pulling");

		if (validationMessage) {
			this.onStatusChange({
				state: "error",
				message: validationMessage
			});
			new Notice(validationMessage);
			return;
		}

		this.syncInProgress = true;
		const notice = new Notice("Start pulling.", 0);

		try {
			const connection = createCouchDbConnection(settings);
			const pendingPaths = this.takePendingSyncPaths();

			try {
				await this.syncFilePaths(pendingPaths);
				await this.syncObsidianConfigurationFiles();
			} catch (error) {
				for (const path of pendingPaths) {
					this.pendingSyncPaths.add(path);
				}

				throw error;
			}

			logger.debug("Executing pull from CouchDb");
			const localRecordsBeforePull = await this.localStore.listFileRecords();
			const localRecordsById = new Map(localRecordsBeforePull.map(
				(record) => [record._id, record])
			);
			const localVaultRecordIds = await this.listCurrentVaultFileRecordIds();
			const recordIdsBeforePull = Array.from(new Set([
				...await this.localStore.listAllFileRecordIds(),
				...localVaultRecordIds
			]));
			const revisionStatesBeforePull = await this.localStore.listFileRevisionStates(recordIdsBeforePull);

			const pullResult = await this.localStore.pullFromCouchDb(
				connection,
				(docsRead) => {
					this.onStatusChange({
						state: "pulling",
						docsRead
					});
				}
			);

			const recordIdsAfterPull = Array.from(new Set([
				...recordIdsBeforePull,
				...await this.localStore.listAllFileRecordIds()
			]));
			const revisionStatesAfterPull = await this.localStore.listFileRevisionStates(recordIdsAfterPull);
			await this.cleanupExcludedObsidianConfigurationRecords(revisionStatesAfterPull);
			const classification = await this.classifyPullResults(
				revisionStatesBeforePull,
				revisionStatesAfterPull,
				localRecordsById
			);
			const deletedRecordIds = classification.deletedRecordIds;
			const conflictedRecordIds = classification.conflictedRecordIds;
			const deletionResult = await this.deleteRemoteDeletedFiles(deletedRecordIds, localRecordsById);
			const restoreResult = await this.restoreVaultFiles(
				new Set([
					...deletedRecordIds,
					...conflictedRecordIds
				])
			);
			const skipped = restoreResult.skipped + deletionResult.skipped;
			const conflicts = restoreResult.conflicts + deletionResult.conflicts + conflictedRecordIds.size;

			this.onStatusChange({
				state: "pulled",
				docsRead: pullResult.docsRead,
				restored: restoreResult.restored,
				deleted: deletionResult.deleted,
				skipped,
				conflicts
			});
			await this.localStore.markRemoteBaseline(connection);
			await this.onOperationCompleted("pullFromCouchDb");

			const reloadMessage = restoreResult.configurationChanged
				|| deletionResult.configurationChanged
				? " Reload Obsidian to apply configuration changes."
				: "";
			new Notice(
				`Read ${pullResult.docsRead}. Restored ${restoreResult.restored}, deleted ${deletionResult.deleted}, skipped ${skipped}, conflicts ${conflicts}.${reloadMessage}`
			);
		} catch (error) {
			logger.error("CouchDB pull failed", error);
			this.onStatusChange({
				state: "error",
				message: "CouchDB pull failed"
			});
			new Notice(getErrorMessage(error, "CouchDB pull failed. Check the console for details."));
		} finally {
			notice.hide();
			this.syncInProgress = false;
			this.scheduleQueuedSync();
		}
	}

	private async classifyPullResults(
		statesBeforePull: FileRevisionState[],
		statesAfterPull: FileRevisionState[],
		localRecordsById: Map<string, VaultFileRecord>
	): Promise<PullClassification> {
		const statesBeforeById = new Map(statesBeforePull.map((state) => [state.recordId, state]));
		const activeConflicts = (await this.conflictStore.listActiveConflicts()).filter(
			(conflict) => !this.isExcludedObsidianConfigurationFilePath(conflict.path)
		);
		const activeConflictsByRecordId = new Map(activeConflicts.map(
			(conflict) => [conflict.recordId, conflict]
		));
		const conflictedRecordIds = new Set(activeConflicts.map((conflict) => conflict.recordId));
		const deletedRecordIds: string[] = [];

		for (const state of statesAfterPull) {
			const rawPath = getPathFromFileRecordId(state.recordId);
			const path = rawPath ? normalizeRestoredPath(rawPath) : "";

			if (!path || isSyncBlacklistedPath(path) || !this.isPathInsideCurrentSyncScope(path)) {
				continue;
			}

			const stateBeforePull = statesBeforeById.get(state.recordId);
			const liveLeaves = state.leaves.filter((leaf) => !leaf.deleted && leaf.record);
			const deletedLeaves = state.leaves.filter((leaf) => leaf.deleted);
			const acknowledgedDeletedRevisions = new Set(
				liveLeaves.flatMap((leaf) => leaf.record?.conflictResolution?.acknowledgedDeletedLeafRevisions ?? [])
			);
			const unacknowledgedDeletedLeaves = deletedLeaves.filter(
				(leaf) => !acknowledgedDeletedRevisions.has(leaf.revision)
			);
			const localRecord = localRecordsById.get(state.recordId);
			const localVariant = await this.captureLocalVariant(path);
			const localContentChanged = await this.hasLocalContentChanged(path, localRecord, localVariant);
			const existingConflict = activeConflictsByRecordId.get(state.recordId);
			let conflictKind: SyncConflictKind | null = null;

			if (existingConflict?.status === "pending-push") {
				continue;
			} else if (existingConflict) {
				conflictKind = existingConflict.kind;
			} else if (liveLeaves.length > 0 && await this.hasRestorePathCollision(path)) {
				conflictKind = "path-collision";
			} else if (liveLeaves.length > 1) {
				conflictKind = stateBeforePull?.leaves.every((leaf) => leaf.deleted) || !localVariant.exists
					? "local-delete-remote-edit"
					: "edit-edit";
			} else if (liveLeaves.length > 0 && unacknowledgedDeletedLeaves.length > 0) {
				conflictKind = stateBeforePull?.leaves.every((leaf) => leaf.deleted) || !localVariant.exists
					? "local-delete-remote-edit"
					: "local-edit-remote-delete";
			} else if (liveLeaves.length === 0 && deletedLeaves.length > 0) {
				if (localVariant.exists && (localContentChanged || !localRecord)) {
					conflictKind = "local-edit-remote-delete";
				} else {
					deletedRecordIds.push(state.recordId);
				}
			} else if (liveLeaves.length === 1 && localContentChanged) {
				const remoteHash = liveLeaves[0]?.record?.contentHash;

				if (remoteHash && remoteHash !== localVariant.contentHash) {
					conflictKind = "edit-edit";
				}
			}

			if (!conflictKind) {
				continue;
			}

			const now = new Date().toISOString();
			await this.conflictStore.upsertConflict({
				_id: createConflictId(state.recordId),
				recordId: state.recordId,
				path,
				kind: conflictKind,
				status: "pending",
				detectedAt: now,
				updatedAt: now,
				observedLeafRevisions: state.leaves.map((leaf) => leaf.revision).sort(),
				localVariant,
				remoteVariants: state.leaves.map((leaf) => ({
					revision: leaf.revision,
					deleted: leaf.deleted,
					winning: leaf.revision === state.winningRevision,
					contentHash: leaf.record?.contentHash,
					fileType: leaf.record?.fileType,
					lastChangedIso: leaf.record?.lastChangedIso
				}))
			});
			conflictedRecordIds.add(state.recordId);
		}

		await this.refreshActiveConflicts();

		return {
			deletedRecordIds: deletedRecordIds.filter((recordId) => !conflictedRecordIds.has(recordId)),
			conflictedRecordIds
		};
	}

	private async cleanupExcludedObsidianConfigurationRecords(
		revisionStates: FileRevisionState[] = []
	) {
		const activeConflicts = await this.conflictStore.listActiveConflicts();
		const excludedConflicts = activeConflicts.filter(
			(conflict) => this.isExcludedObsidianConfigurationFilePath(conflict.path)
		);
		const excludedRecordIds = new Set(
			revisionStates.flatMap((state) => {
				const rawPath = getPathFromFileRecordId(state.recordId);
				const path = rawPath ? normalizeRestoredPath(rawPath) : "";

				return path && this.isExcludedObsidianConfigurationFilePath(path)
					? [state.recordId]
					: [];
			})
		);

		for (const conflict of excludedConflicts) {
			excludedRecordIds.add(conflict.recordId);
		}

		for (const recordId of excludedRecordIds) {
			await this.localStore.resolveFileRecordAsDeleted(recordId);
		}

		for (const conflict of excludedConflicts) {
			const resolvedAt = new Date().toISOString();
			await this.conflictStore.updateConflict(conflict._id, (current) => ({
				...current,
				status: "resolved",
				resolution: {
					strategy: "delete",
					resolvedDocumentIds: [conflict.recordId],
					resolvedAt
				},
				error: undefined
			}));
		}

		if (excludedRecordIds.size > 0) {
			logger.info("Excluded Obsidian configuration records cleaned up", {
				records: excludedRecordIds.size,
				conflicts: excludedConflicts.length
			});
		}
	}

	private async captureLocalVariant(path: string): Promise<SyncConflictLocalVariant> {
		const record = await this.createLocalRecord(path);

		if (!record) {
			return { exists: false };
		}

		return {
			exists: true,
			contentHash: record.contentHash,
			fileType: record.fileType,
			lastChanged: record.lastChanged
		};
	}

	private async hasLocalContentChanged(
		path: string,
		localRecord: VaultFileRecord | undefined,
		localVariant: SyncConflictLocalVariant
	) {
		if (!localVariant.exists) {
			return false;
		}

		if (!localRecord) {
			return true;
		}

		return !(await this.localPathMatchesRecord(path, localRecord));
	}

	private async hasRestorePathCollision(path: string) {
		if (isObsidianConfigFilePath(this.app, path)) {
			return (await this.app.vault.adapter.stat(path))?.type === "folder";
		}

		const existing = this.app.vault.getAbstractFileByPath(path);

		if (existing && !(existing instanceof TFile)) {
			return true;
		}

		const parts = path.split("/");
		parts.pop();
		let parentPath = "";

		for (const part of parts) {
			parentPath = parentPath ? `${parentPath}/${part}` : part;

			if (this.app.vault.getAbstractFileByPath(parentPath) instanceof TFile) {
				return true;
			}
		}

		return false;
	}

	private async deleteRemoteDeletedFiles(
		deletedRecordIds: string[],
		localRecordsById: Map<string, VaultFileRecord>
	): Promise<RemoteDeletionResult> {
		let deleted = 0;
		let skipped = 0;
		let conflicts = 0;
		let configurationChanged = false;
		const uniqueDeletedRecordIds = Array.from(new Set(deletedRecordIds));

		this.applyingRemoteChange = true;

		try {
			for (const [index, recordId] of uniqueDeletedRecordIds.entries()) {
				const deleteStatus = await this.deleteRemoteDeletedFile(recordId, localRecordsById);

				if (deleteStatus === "deleted") {
					deleted += 1;
					const rawPath = getPathFromFileRecordId(recordId);
					configurationChanged = configurationChanged
						|| (rawPath !== null && isObsidianConfigFilePath(this.app, rawPath));
				} else if (deleteStatus === "conflict") {
					conflicts += 1;
				} else {
					skipped += 1;
				}

				this.onStatusChange({
					state: "deleting",
					current: index + 1,
					total: uniqueDeletedRecordIds.length,
					deleted,
					skipped,
					conflicts
				});
			}
		} finally {
			this.applyingRemoteChange = false;
		}

		return {
			total: uniqueDeletedRecordIds.length,
			deleted,
			skipped,
			conflicts,
			configurationChanged
		};
	}

	private async deleteRemoteDeletedFile(
		recordId: string,
		localRecordsById: Map<string, VaultFileRecord>
	): Promise<"deleted" | "skipped" | "conflict"> {
		const rawPath = getPathFromFileRecordId(recordId);

		if (!rawPath) {
			return "skipped";
		}

		const path = normalizeRestoredPath(rawPath);
		if (!path || isSyncBlacklistedPath(path) || !this.isPathInsideCurrentSyncScope(path)) {
			return "skipped";
		}

		const localRecord = localRecordsById.get(recordId);
		const configFile = isObsidianConfigFilePath(this.app, path);
		const existingFile = configFile
			? await this.app.vault.adapter.stat(path)
			: null;
		const existingVaultFile = configFile
			? null
			: this.app.vault.getAbstractFileByPath(path);

		if (!existingFile && !existingVaultFile) {
			await this.localStore.deleteFileRecordById(recordId);
			return "skipped";
		}

		if (
			(existingFile && existingFile.type !== "file")
			|| (existingVaultFile && !(existingVaultFile instanceof TFile))
		) {
			return "conflict";
		}

		if (localRecord && !(await this.localPathMatchesRecord(path, localRecord))) {
			return "conflict";
		}

		const parentFolder = existingVaultFile instanceof TFile ? existingVaultFile.parent : null;
		await this.deleteLocalFile(path);

		if (!configFile) {
			await this.removeEmptyParentFolders(parentFolder);
		}

		await this.localStore.deleteFileRecordById(recordId);
		return "deleted";
	}

	private async localFileMatchesRecord(file: TFile, record: VaultFileRecord) {
		const [localHash, recordHash] = await Promise.all([
			createLocalFileContentHash(this.app, file, record.fileType),
			getRecordContentHash(record)
		]);

		return localHash === recordHash;
	}

	private async localPathMatchesRecord(path: string, record: VaultFileRecord) {
		if (record.source === "obsidian-config" || isObsidianConfigFilePath(this.app, path)) {
			const stat = await this.app.vault.adapter.stat(path);

			if (!stat || stat.type !== "file") {
				return false;
			}

			const [localHash, recordHash] = await Promise.all([
				createAdapterFileContentHash(this.app, path),
				getRecordContentHash(record)
			]);

			return localHash === recordHash;
		}

		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile && this.localFileMatchesRecord(file, record);
	}

	async testRemoteConnection() {
		if (this.isRunning()) return;

		const settings = this.getSettings();

		if (settings.remoteBackend === "nextcloud") {
			return this.testNextcloudConnection(settings);
		}

		return this.testCouchDbConnection(settings);
	}

	private async testNextcloudConnection(settings: MySyncSettings) {
		const validationMessage = validateNextcloudSettings(settings, "testing");

		if (validationMessage) {
			this.onStatusChange({
				state: "error",
				message: validationMessage
			});
			new Notice(validationMessage);
			return;
		}

		this.syncInProgress = true;
		let failed = false;

		try {
			this.onStatusChange({ state: "testing" });

			const rootUrl = settings.nextcloudUrl.replace(/\/+$/, "");
			const webdavUrl = `${rootUrl}/remote.php/webdav/`;
			
			const token = btoa(`${settings.nextcloudUsername}:${settings.nextcloudPassword}`);
			
			const result = await requestUrl({
				url: webdavUrl,
				method: "PROPFIND",
				headers: {
					"Authorization": `Basic ${token}`,
					"Depth": "0"
				}
			});

			if (result.status >= 200 && result.status < 300) {
				this.onStatusChange({
					state: "tested",
					databaseName: "Nextcloud",
				});
				new Notice("Connected to Nextcloud successfully");
			} else {
				throw new Error(`HTTP Error: ${result.status}`);
			}
		} catch (error) {
			failed = true;
			logger.error("Nextcloud connection test failed", error);
			this.onStatusChange({
				state: "error",
				message: "Nextcloud connection failed"
			});
			new Notice(getErrorMessage(error, "Nextcloud connection failed. Check the console for details"));
		} finally {
			this.syncInProgress = false;

			if (!failed) {
				this.refreshQueuedStatus();
			}
		}
	}

	private async testCouchDbConnection(settings: MySyncSettings) {
		const validationMessage = validateCouchDbSettings(settings, "testing");

		if (validationMessage) {
			this.onStatusChange({
				state: "error",
				message: validationMessage
			});
			new Notice(validationMessage);
			return;
		}

		this.syncInProgress = true;
		let failed = false;

		try {
			this.onStatusChange({ state: "testing" });

			const result = await this.localStore.testCouchDbConnection({
				url: settings.couchDbUrl,
				database: settings.couchDbDatabase,
				username: settings.couchDbUsername,
				password: settings.couchDbPassword
			});

			this.onStatusChange({
				state: "tested",
				databaseName: result.databaseName,
				documentCount: result.documentCount
			});
			new Notice("Connected to CouchDB database");
		} catch (error) {
			failed = true;
			logger.error("CouchDB connection test failed", error);
			this.onStatusChange({
				state: "error",
				message: "CouchDB connection failed"
			});
			new Notice(getErrorMessage(error, "CouchDB connection failed. Check the console for details"));
		} finally {
			this.syncInProgress = false;

			if (!failed) {
				this.refreshQueuedStatus();
			}
		}
	}

	private async syncLocalFiles(): Promise<LocalSyncResult> {
		const syncFolder = this.getCurrentSyncFolder();

		if (!syncFolder) {
			throw new Error("Set a folder before syncing.");
		}

		const syncFolderState = getSyncFolderState(this.app, syncFolder);

		if (!syncFolderState.valid) {
			throw new Error(syncFolderState.message);
		}

		const files = collectSyncableFilesInFolder(syncFolderState.folder);
		logger.info("Local files collected for sync", {
			syncFolder,
			total: files.length
		});

		let savedCount = 0;
		let skippedCount = 0;

		for (const [index, file] of files.entries()) {
			const saved = this.conflictedPaths.has(file.path)
				? false
				: await this.syncFileIfChanged(file);

			if (saved) {
				savedCount += 1;
			} else {
				skippedCount += 1;
			}

			logger.debug("Local file sync completed", {
				current: index + 1,
				total: files.length,
				path: file.path,
				saved,
				savedCount,
				skippedCount
			});

			this.onStatusChange({
				state: "syncing",
				current: index + 1,
				total: files.length,
				saved: savedCount,
				skipped: skippedCount
			});
		}

		const result = await this.syncObsidianConfigurationFiles({
			total: files.length,
			saved: savedCount,
			skipped: skippedCount
		});
		await this.localStore.markLocalSyncBaseline(syncFolder);

		return result;
	}

	private async syncObsidianConfigurationFiles(
		initialResult: LocalSyncResult = { total: 0, saved: 0, skipped: 0 }
	): Promise<LocalSyncResult> {
		const paths = this.isObsidianConfigSyncEnabled()
			? (await listObsidianConfigFilePaths(this.app))
				.filter((path) => this.isSyncedObsidianConfigurationFilePath(path))
			: [];

		const currentRecordIds = new Set(paths.map(createFileRecordId));

		const missingRecords = (await this.localStore.listFileRecords()).filter(
			(record) => record.source === "obsidian-config"
				&& !currentRecordIds.has(record._id)
				&& !this.conflictedPaths.has(record.path)
		);

		const total = initialResult.total + paths.length + missingRecords.length;
		let saved = initialResult.saved;
		let skipped = initialResult.skipped;
		let current = initialResult.total;

		logger.info("Configuration files collected: ", {
			configDir: this.app.vault.configDir,
			files: paths.length,
			deleted: missingRecords.length
		});

		for (const path of paths) {
			const changed = this.conflictedPaths.has(path)
				? false
				: await this.localStore.saveFileRecordIfChanged(
					await createObsidianConfigFileRecord(this.app, path)
				);

			if (changed) {
				saved += 1;
			} else {
				skipped += 1;
			}

			current += 1;
			this.onStatusChange({
				state: "syncing",
				current,
				total,
				saved,
				skipped
			});
		}

		for (const record of missingRecords) {
			await this.localStore.deleteFileRecordById(record._id);
			saved += 1;
			current += 1;
			this.onStatusChange({
				state: "syncing",
				current,
				total,
				saved,
				skipped
			});
		}

		return { total, saved, skipped };
	}

	private async restoreVaultFiles(deletedRecordIds = new Set<string>()): Promise<RestoreResult> {
		logger.debug("Restoring vault files: ", { deletedRecordIds });

		let restored = 0;
		let skipped = 0;
		let conflicts = 0;
		let configurationChanged = false;

		const records = await this.localStore.listFileRecords();
		this.applyingRemoteChange = true;

		try {
			for (const [index, record] of records.entries()) {
				let restoreStatus: "restored" | "skipped" | "conflict";

				try {
					restoreStatus = deletedRecordIds.has(record._id) ? "skipped" : await this.restoreVaultFile(record);
				} catch (error) {
					logger.warn("Skipped remote file during restore", error, { path: record.path });
					restoreStatus = "skipped";
				}

				if (restoreStatus === "restored") {
					restored += 1;
					configurationChanged = configurationChanged || isObsidianConfigFilePath(this.app, record.path);
				} else if (restoreStatus === "conflict") {
					conflicts += 1;
				} else {
					skipped += 1;
				}

				this.onStatusChange({
					state: "restoring",
					current: index + 1,
					total: records.length,
					restored,
					skipped,
					conflicts
				});
			}
		} finally {
			this.applyingRemoteChange = false;
		}

		return {
			total: records.length,
			restored,
			skipped,
			conflicts,
			configurationChanged
		};
	}

	private async restoreVaultFile(record: VaultFileRecord): Promise<"restored" | "skipped" | "conflict"> {
		const path = normalizeRestoredPath(record.path);

		if (
			!path
			|| record.type !== "vault-file"
			|| isSyncBlacklistedPath(path)
			|| !this.isPathInsideCurrentSyncScope(path)
		) {
			return "skipped";
		}

		if (record.source === "obsidian-config" || isObsidianConfigFilePath(this.app, path)) {
			if (!isObsidianConfigFilePath(this.app, path)) {
				return "skipped";
			}

			const existing = await this.app.vault.adapter.stat(path);

			if (existing?.type === "folder") {
				return "conflict";
			}

			if (existing?.type === "file" && await this.localPathMatchesRecord(path, record)) {
				return "skipped";
			}

			await this.writeRecordToVault(record, path);
			return "restored";
		}

		const existingFile = this.app.vault.getAbstractFileByPath(path);
		if (existingFile instanceof TFile) {
			if (await this.localFileMatchesRecord(existingFile, record)) {
				return "skipped";
			}

			await this.overwriteLocalFile(record, existingFile);
			return "restored";
		}

		const folderStatus = await this.ensureParentFolders(path);
		if (folderStatus === "conflict") {
			return "skipped";
		}

		const fileTypeIstext = record.fileType === "markdown" && typeof record.content === "string";
		if (fileTypeIstext) {
			await this.app.vault.create(path, record.content!);
			return "restored";
		}

		if (!fileTypeIstext) {
			const data = await getAttachmentArrayBuffer(record);
			if (!data) return "skipped";

			await this.app.vault.createBinary(path, data);
			return "restored";
		}

		return "skipped";
	}

	private async overwriteLocalFile(record: VaultFileRecord, existingFile: TFile): Promise<void> {
		const fileTypeIstext = record.fileType === "markdown" && typeof record.content === "string";

		if (fileTypeIstext) {
			await this.app.vault.modify(existingFile, record.content!);

		} else if (!fileTypeIstext && typeof record._attachments?.file?.data !== "undefined") {
			const data = await getAttachmentArrayBuffer(record);
			if (data) await this.app.vault.modifyBinary(existingFile, data);
		}
	}

	private async ensureParentFolders(path: string): Promise<"ok" | "conflict"> {
		const parts = path.split("/");
		parts.pop();

		let currentPath = "";

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existingFile = this.app.vault.getAbstractFileByPath(currentPath);

			if (existingFile instanceof TFile) {
				return "conflict";
			}

			if (!existingFile) {
				await this.app.vault.createFolder(currentPath);
			} else if (!(existingFile instanceof TFolder)) {
				return "conflict";
			}
		}

		return "ok";
	}

	queueFileSync(abstractFile: TAbstractFile) {
		if (this.applyingRemoteChange) {
			return;
		}

		if (!(abstractFile instanceof TFile)) {
			return;
		}

		if (!this.isFileInsideCurrentSyncFolder(abstractFile)) {
			return;
		}

		if (this.conflictedPaths.has(abstractFile.path)) {
			return;
		}

		this.pendingSyncPaths.add(abstractFile.path);

		if (!this.syncInProgress) {
			this.onStatusChange({
				state: "queued",
				pending: this.pendingSyncPaths.size
			});
		}

		this.scheduleQueuedSync();
	}

	async handleRenamedFile(abstractFile: TAbstractFile, oldPath: string) {
		if (this.applyingRemoteChange || this.conflictedPaths.has(oldPath)) {
			return;
		}

		if (!isSyncBlacklistedPath(oldPath)) {
			await this.localStore.deleteFileRecordByPath(oldPath);
		}

		this.queueFileSync(abstractFile);
	}

	async handleDeletedFile(abstractFile: TAbstractFile) {
		if (this.applyingRemoteChange || this.conflictedPaths.has(abstractFile.path)) {
			return;
		}

		if (
			abstractFile instanceof TFile
			&& this.isFileInsideCurrentSyncFolder(abstractFile)
		) {
			await this.localStore.deleteFileRecordByPath(abstractFile.path);
		}
	}

	getEmptyVaultFolderCount() {
		return this.collectEmptyVaultFolders().length;
	}

	async cleanEmptyVaultFolders(): Promise<EmptyFolderCleanupResult | null> {
		if (this.isRunning()) {
			return null;
		}

		this.syncInProgress = true;
		const notice = new Notice("Cleaning empty folders.", 0);
		let removed = 0;
		let skipped = 0;
		let folders: TFolder[] = [];

		try {
			folders = this.collectEmptyVaultFolders();

			for (const [index, folder] of folders.entries()) {
				if (await this.removeEmptyFolder(folder)) {
					removed += 1;
				} else {
					skipped += 1;
				}

				this.onStatusChange({
					state: "cleaning-empty-folders",
					current: index + 1,
					total: folders.length,
					removed,
					skipped
				});
			}

			const result = { total: folders.length, removed, skipped };
			this.onStatusChange({
				state: "empty-folders-cleaned",
				removed,
				skipped
			});
			new Notice(`Removed ${removed} empty folder(s), skipped ${skipped}.`);
			logger.info("Empty vault folder cleanup completed", result);
			return result;
		} catch (error) {
			logger.error("Empty vault folder cleanup failed", error);
			this.onStatusChange({
				state: "error",
				message: "Empty vault folder cleanup failed"
			});
			new Notice(getErrorMessage(
				error,
				"Empty vault folder cleanup failed. Check the console for details."
			));
			return null;
		} finally {
			notice.hide();
			this.syncInProgress = false;
			this.scheduleQueuedSync();
		}
	}

	close() {
		if (this.syncQueueTimer !== null) {
			window.clearTimeout(this.syncQueueTimer);
		}

		void this.localStore.close();
		void this.conflictStore.close();
	}

	private scheduleQueuedSync() {
		if (this.pendingSyncPaths.size === 0 || this.syncInProgress || this.syncQueueTimer !== null) {
			return;
		}

		this.syncQueueTimer = window.setTimeout(() => {
			this.syncQueueTimer = null;
			void this.syncQueuedFiles();
		}, 1000);
	}

	private async syncQueuedFiles() {
		if (this.syncInProgress || this.pendingSyncPaths.size === 0) {
			return;
		}

		this.syncInProgress = true;
		let failed = false;
		const paths = this.takePendingSyncPaths();

		try {
			const result = await this.syncFilePaths(paths);

			this.onStatusChange({
				state: "done",
				total: result.total,
				saved: result.saved,
				skipped: result.skipped
			});
		} catch (error) {
			failed = true;

			for (const path of paths) {
				this.pendingSyncPaths.add(path);
			}

			logger.error("Incremental sync failed", error);
			this.onStatusChange({
				state: "error",
				message: "Incremental sync failed"
			});
			new Notice("MySync incremental sync failed. Check the console for details");
		} finally {
			this.syncInProgress = false;
			this.scheduleQueuedSync();

			if (!failed) {
				this.refreshQueuedStatus();
			}
		}
	}

	private takePendingSyncPaths() {
		if (this.syncQueueTimer !== null) {
			window.clearTimeout(this.syncQueueTimer);
			this.syncQueueTimer = null;
		}

		const paths = Array.from(this.pendingSyncPaths);
		this.pendingSyncPaths.clear();
		return paths;
	}

	private async syncFilePaths(paths: string[]): Promise<LocalSyncResult> {
		let saved = 0;
		let skipped = 0;

		for (const [index, path] of paths.entries()) {
			const abstractFile = this.app.vault.getAbstractFileByPath(path);

			if (
				!this.conflictedPaths.has(path)
				&& abstractFile instanceof TFile
				&& this.isFileInsideCurrentSyncFolder(abstractFile)
			) {
				if (await this.syncFileIfChanged(abstractFile)) {
					saved += 1;
				} else {
					skipped += 1;
				}
			}

			this.onStatusChange({
				state: "syncing",
				current: index + 1,
				total: paths.length,
				saved,
				skipped
			});
		}

		return {
			total: paths.length,
			saved,
			skipped
		};
	}

	private refreshQueuedStatus() {
		if (this.syncInProgress) {
			return;
		}

		if (this.pendingSyncPaths.size > 0) {
			this.onStatusChange({
				state: "queued",
				pending: this.pendingSyncPaths.size
			});
		}
	}

	private isFileInsideCurrentSyncFolder(file: TFile) {
		return isSyncableVaultFile(file) && isFileInsideSyncFolder(file, this.getCurrentSyncFolder());
	}

	private async listCurrentVaultFileRecordIds() {
		const syncFolder = this.getCurrentSyncFolder();
		const syncFolderState = getSyncFolderState(this.app, syncFolder);

		if (!syncFolderState.valid) {
			throw new Error(syncFolderState.message);
		}

		const [vaultRecordIds, configPaths] = await Promise.all([
			Promise.resolve(
				collectSyncableFilesInFolder(syncFolderState.folder)
					.map((file) => createFileRecordId(file.path))
			),
			this.isObsidianConfigSyncEnabled()
				? listObsidianConfigFilePaths(this.app).then((paths) => paths.filter(
					(path) => this.isSyncedObsidianConfigurationFilePath(path)
				))
				: Promise.resolve([])
		]);

		return [
			...vaultRecordIds,
			...configPaths.map(createFileRecordId)
		];
	}

	private getCurrentSyncFolder() {
		const settings = this.getSettings();
		return getSyncFolder(this.app, settings.syncFolderMode, settings.customSyncFolder);
	}

	private isPathInsideCurrentSyncScope(path: string) {
		if (isObsidianConfigFilePath(this.app, path)) {
			return this.isSyncedObsidianConfigurationFilePath(path);
		}

		return isPathInsideSyncFolder(path, this.getCurrentSyncFolder());
	}

	private async createLocalRecord(path: string) {
		if (isObsidianConfigFilePath(this.app, path)) {
			const stat = await this.app.vault.adapter.stat(path);
			return stat?.type === "file"
				? createObsidianConfigFileRecord(this.app, path)
				: null;
		}

		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? createFileRecord(this.app, file) : null;
	}

	private async localPathExists(path: string) {
		if (isObsidianConfigFilePath(this.app, path)) {
			return this.app.vault.adapter.exists(path);
		}

		return this.app.vault.getAbstractFileByPath(path) !== null;
	}

	private async deleteLocalFile(path: string) {
		if (isObsidianConfigFilePath(this.app, path)) {
			const stat = await this.app.vault.adapter.stat(path);

			if (!stat) {
				return;
			}

			if (stat.type !== "file") {
				throw new Error(`Cannot delete ${path}: the path is not a file.`);
			}

			if (!(await this.app.vault.adapter.trashSystem(path))) {
				await this.app.vault.adapter.trashLocal(path);
			}

			return;
		}

		const existing = this.app.vault.getAbstractFileByPath(path);

		if (existing instanceof TFile) {
			await this.app.fileManager.trashFile(existing);
		} else if (existing) {
			throw new Error(`Cannot delete ${path}: the path is not a file.`);
		}
	}

	private async removeEmptyParentFolders(folder: TFolder | null) {
		const syncFolderState = getSyncFolderState(this.app, this.getCurrentSyncFolder());

		if (!syncFolderState.valid) {
			return;
		}

		const vaultRoot = this.app.vault.getRoot();
		let currentFolder = folder;

		while (
			currentFolder
			&& currentFolder !== vaultRoot
			&& currentFolder.path !== syncFolderState.folder.path
		) {
			if (currentFolder.children.length > 0) {
				return;
			}

			const parentFolder = currentFolder.parent;

			if (!(await this.removeEmptyFolder(currentFolder))) {
				return;
			}

			currentFolder = parentFolder;
		}
	}

	private collectEmptyVaultFolders() {
		const folders: TFolder[] = [];
		const configFolder = this.app.vault.configDir.trim().replace(/^\/+|\/+$/g, "");

		const collect = (folder: TFolder): boolean => {
			if (
				folder.path === configFolder
				|| (configFolder.length > 0 && folder.path.startsWith(`${configFolder}/`))
			) {
				return false;
			}

			let canRemoveFolder = true;

			for (const child of folder.children) {
				if (child instanceof TFolder) {
					canRemoveFolder = collect(child) && canRemoveFolder;
				} else {
					canRemoveFolder = false;
				}
			}

			if (folder === this.app.vault.getRoot()) {
				return false;
			}

			if (canRemoveFolder) {
				folders.push(folder);
				return true;
			}

			return false;
		};

		collect(this.app.vault.getRoot());
		return folders;
	}

	private async removeEmptyFolder(folder: TFolder) {
		if (folder.children.length > 0) {
			return false;
		}

		try {
			await this.app.fileManager.trashFile(folder);
			return true;
		} catch (error) {
			logger.warn("Failed to remove empty folder", error, { path: folder.path });
			return false;
		}
	}

	private async syncFileIfChanged(file: TFile) {
		if (!isSyncableVaultFile(file)) {
			logger.debug("Skipped blacklisted local file", { path: file.path });
			return false;
		}

		const record = await createFileRecord(this.app, file);
		logger.debug("Local file record created", {
			recordId: record._id,
			path: record.path,
			fileType: record.fileType,
			size: record.size,
			hasContent: typeof record.content === "string",
			hasAttachments: typeof record._attachments === "object"
		});

		return this.localStore.saveFileRecordIfChanged(record);
	}
}

function getPendingPushBlockingState(
	hasLocalSyncBaseline: boolean,
	hasRemoteBaseline: boolean
): { statusMessage: string; noticeMessage: string } | null {
	if (!hasLocalSyncBaseline && !hasRemoteBaseline) {
		return {
			statusMessage: "Local and remote baselines required",
			noticeMessage: "Run a full local sync and establish the remote baseline with a full push or pull before pushing pending changes."
		};
	}

	if (!hasLocalSyncBaseline) {
		return {
			statusMessage: "Full local sync required",
			noticeMessage: "Run Sync now before pushing pending changes."
		};
	}

	if (!hasRemoteBaseline) {
		return {
			statusMessage: "Remote baseline required",
			noticeMessage: "Run a full push or pull before pushing pending changes."
		};
	}

	return null;
}

function createConflictId(recordId: string) {
	return `mysync-conflict:${recordId}`;
}

function arraysEqual(left: string[], right: string[]) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateCouchDbSettings(settings: MySyncSettings, operation = "pushing") {
	if (!settings.couchDbUrl) {
		return `Set a CouchDB URL before ${operation}.`;
	}

	if (!isHttpUrl(settings.couchDbUrl)) {
		return `Set a valid CouchDB URL before ${operation}.`;
	}

	if (!settings.couchDbDatabase) {
		return `Set a CouchDB database before ${operation}.`;
	}

	return null;
}

function validateNextcloudSettings(settings: MySyncSettings, operation = "pushing") {
	if (!settings.nextcloudUrl) {
		return `Set a Nextcloud URL before ${operation}.`;
	}

	if (!isHttpUrl(settings.nextcloudUrl)) {
		return `Set a valid Nextcloud URL before ${operation}.`;
	}

	if (!settings.nextcloudUsername || !settings.nextcloudPassword) {
		return `Set Nextcloud credentials before ${operation}.`;
	}

	return null;
}

function createCouchDbConnection(settings: MySyncSettings): CouchDbConnection {
	return {
		url: settings.couchDbUrl,
		database: settings.couchDbDatabase,
		username: settings.couchDbUsername,
		password: settings.couchDbPassword
	};
}

function isHttpUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function getErrorMessage(error: unknown, fallback: string) {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	return fallback;
}

function normalizeRestoredPath(path: string) {
	if (path.startsWith("/")) {
		return null;
	}

	const normalizedPath = path.trim().replace(/^\/+|\/+$/g, "");
	const pathParts = normalizedPath.split("/");

	if (!normalizedPath || pathParts.includes("..") || pathParts.includes("")) {
		return null;
	}

	return normalizedPath;
}

async function getAttachmentArrayBuffer(record: VaultFileRecord) {
	const attachment = record._attachments?.file;

	if (!attachment || !("data" in attachment)) {
		return null;
	}

	const data = attachment.data;

	if (data instanceof Blob) {
		return data.arrayBuffer();
	}

	return null;
}

async function getRecordContentHash(record: VaultFileRecord) {
	if (record.contentHash) {
		return record.contentHash;
	}

	if (record.fileType === "markdown" && typeof record.content === "string") {
		return createTextContentHash(record.content);
	}

	const data = await getAttachmentArrayBuffer(record);
	if (data) {
		return createBinaryContentHash(data);
	}

	return null;
}
