import { App, Notice, TAbstractFile, TFile, TFolder } from "obsidian";
import type { MySyncSettings } from "../settings";
import type { CouchDbConnection, PouchDbFileStore } from "./pouchdb-store";
import type { VaultFileRecord } from "./types";
import {
	collectSyncableFilesInFolder,
	createBinaryContentHash,
	createFileRecord,
	createFileRecordId,
	createLocalFileContentHash,
	createTextContentHash,
	getPathFromFileRecordId,
	getSyncFolder,
	getSyncFolderState,
	isFileInsideSyncFolder,
	isSyncBlacklistedPath,
	isSyncableVaultFile,
	isPathInsideSyncFolder
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
}

interface RemoteDeletionResult {
	total: number;
	deleted: number;
	skipped: number;
	conflicts: number;
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
	| { state: "testing" }
	| { state: "tested"; databaseName: string; documentCount?: number }
	| { state: "error"; message: string };

export type CompletedSyncOperation = "syncNow" | "pushToCouchDb" | "pullFromCouchDb";

const logger = new Logger("SyncService");

export class SyncService {
	private syncInProgress = false;
	private pendingSyncPaths = new Set<string>();
	private syncQueueTimer: number | null = null;
	private applyingRemoteDeletion = false;

	constructor(
		private app: App,
		private store: PouchDbFileStore,
		private getSettings: () => MySyncSettings,
		private onStatusChange: (status: SyncStatus) => void,
		private onOperationCompleted: (operation: CompletedSyncOperation) => Promise<void>
	) {
		this.onStatusChange({ state: "idle" });
	}

	isRunning(): boolean {
		if (this.syncInProgress) new Notice("A sync process is already running.");
		return this.syncInProgress;
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
			const canPush = await this.store.canPushToCouchDb(connection);

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

			const pushResult = await this.store.pushToCouchDb(
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

			await this.store.markRemoteBaseline(connection);
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

		this.syncInProgress = true;
		let failed = false;
		const notice = new Notice("Pushing pending changes.", 0);
		let pendingPaths: string[] = [];

		try {
			const connection = createCouchDbConnection(settings);
			const syncFolder = this.getCurrentSyncFolder();
			const [hasLocalSyncBaseline, hasRemoteBaseline] = await Promise.all([
				this.store.hasLocalSyncBaseline(syncFolder),
				this.store.hasRemoteBaseline(connection)
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
			} catch (error) {
				for (const path of pendingPaths) {
					this.pendingSyncPaths.add(path);
				}

				throw error;
			}

			const pushResult = await this.store.pushToCouchDb(
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
				database: connection.database,
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
			const localRecordsBeforePull = await this.store.listFileRecords();
			const localRecordsById = new Map(localRecordsBeforePull.map(
				(record) => [record._id, record])
			);
			const localVaultRecordIds = this.listCurrentVaultFileRecordIds();

			const pullResult = await this.store.pullFromCouchDb(
				connection,
				(docsRead) => {
					this.onStatusChange({
						state: "pulling",
						docsRead
					});
				}
			);

			const deletionCandidateIds = Array.from(
				new Set([
					...localRecordsById.keys(),
					...localVaultRecordIds
				])
			);

			const deletedRecordIds = await this.store.listDeletedFileRecordIds(deletionCandidateIds);
			const deletionResult = await this.deleteRemoteDeletedFiles(deletedRecordIds, localRecordsById);
			const restoreResult = await this.restoreVaultFiles(new Set(deletedRecordIds));
			const skipped = restoreResult.skipped + deletionResult.skipped;
			const conflicts = restoreResult.conflicts + deletionResult.conflicts;

			this.onStatusChange({
				state: "pulled",
				docsRead: pullResult.docsRead,
				restored: restoreResult.restored,
				deleted: deletionResult.deleted,
				skipped,
				conflicts
			});
			await this.store.markRemoteBaseline(connection);
			await this.onOperationCompleted("pullFromCouchDb");

			new Notice(
				`Read ${pullResult.docsRead}. Restored ${restoreResult.restored}, deleted ${deletionResult.deleted}, skipped ${skipped}, conflicts ${conflicts}.`
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

	private async deleteRemoteDeletedFiles(
		deletedRecordIds: string[],
		localRecordsById: Map<string, VaultFileRecord>
	): Promise<RemoteDeletionResult> {
		let deleted = 0;
		let skipped = 0;
		let conflicts = 0;
		const uniqueDeletedRecordIds = Array.from(new Set(deletedRecordIds));

		this.applyingRemoteDeletion = true;

		try {
			for (const [index, recordId] of uniqueDeletedRecordIds.entries()) {
				const deleteStatus = await this.deleteRemoteDeletedFile(recordId, localRecordsById);

				if (deleteStatus === "deleted") {
					deleted += 1;
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
			this.applyingRemoteDeletion = false;
		}

		return {
			total: uniqueDeletedRecordIds.length,
			deleted,
			skipped,
			conflicts
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
		const syncFolder = this.getCurrentSyncFolder();

		if (!path || isSyncBlacklistedPath(path) || !isPathInsideSyncFolder(path, syncFolder)) {
			return "skipped";
		}

		const existingFile = this.app.vault.getAbstractFileByPath(path);
		const localRecord = localRecordsById.get(recordId);

		if (!existingFile) {
			await this.store.deleteFileRecordById(recordId);
			return "skipped";
		}

		if (!(existingFile instanceof TFile)) {
			return "conflict";
		}

		if (localRecord && !(await this.localFileMatchesRecord(existingFile, localRecord))) {
			return "conflict";
		}

		await this.app.fileManager.trashFile(existingFile);
		await this.store.deleteFileRecordById(recordId);
		return "deleted";
	}

	private async localFileMatchesRecord(file: TFile, record: VaultFileRecord) {
		const [localHash, recordHash] = await Promise.all([
			createLocalFileContentHash(this.app, file, record.fileType),
			getRecordContentHash(record)
		]);

		return localHash === recordHash;
	}

	async testCouchDbConnection() {
		if (this.isRunning()) return;

		const settings = this.getSettings();
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

			const result = await this.store.testCouchDbConnection({
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
			const saved = await this.syncFileIfChanged(file);

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

		await this.store.markLocalSyncBaseline(syncFolder);

		return {
			total: files.length,
			saved: savedCount,
			skipped: skippedCount
		};
	}

	private async restoreVaultFiles(deletedRecordIds = new Set<string>()): Promise<RestoreResult> {
		let restored = 0;
		let skipped = 0;
		let conflicts = 0;

		const records = await this.store.listFileRecords();

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

		return {
			total: records.length,
			restored,
			skipped,
			conflicts
		};
	}

	private async restoreVaultFile(record: VaultFileRecord): Promise<"restored" | "skipped" | "conflict"> {
		const path = normalizeRestoredPath(record.path);
		if (!path || record.type !== "vault-file" || isSyncBlacklistedPath(path)) {
			return "skipped";
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
		if (!(abstractFile instanceof TFile)) {
			return;
		}

		if (!this.isFileInsideCurrentSyncFolder(abstractFile)) {
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
		if (!isSyncBlacklistedPath(oldPath)) {
			await this.store.deleteFileRecordByPath(oldPath);
		}

		this.queueFileSync(abstractFile);
	}

	async handleDeletedFile(abstractFile: TAbstractFile) {
		if (this.applyingRemoteDeletion) {
			return;
		}

		if (
			abstractFile instanceof TFile
			&& this.isFileInsideCurrentSyncFolder(abstractFile)
		) {
			await this.store.deleteFileRecordByPath(abstractFile.path);
		}
	}

	close() {
		if (this.syncQueueTimer !== null) {
			window.clearTimeout(this.syncQueueTimer);
		}

		void this.store.close();
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

			if (abstractFile instanceof TFile && this.isFileInsideCurrentSyncFolder(abstractFile)) {
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

	private listCurrentVaultFileRecordIds() {
		const syncFolder = this.getCurrentSyncFolder();
		const syncFolderState = getSyncFolderState(this.app, syncFolder);

		if (!syncFolderState.valid) {
			throw new Error(syncFolderState.message);
		}

		return collectSyncableFilesInFolder(syncFolderState.folder).map((file) => createFileRecordId(file.path));
	}

	private getCurrentSyncFolder() {
		const settings = this.getSettings();
		return getSyncFolder(this.app, settings.syncFolderMode, settings.customSyncFolder);
	}

	private async syncFileIfChanged(file: TFile) {
		if (!isSyncableVaultFile(file)) {
			logger.debug("Skipped blacklisted local file", {
				path: file.path
			});
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

		return this.store.saveFileRecordIfChanged(record);
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
