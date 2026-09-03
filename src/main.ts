import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, MySyncSettingTab, type MySyncSettings, isRemoteSyncBackend } from "./settings";
import { PouchDbFileStore } from "./sync/pouchdb-store";
import { PouchDbConflictStore } from "./sync/conflict-store";
import { SyncService, type CompletedSyncOperation, type SyncStatus } from "./sync/sync-service";
import type { SyncConflict } from "./sync/types";
import { ConflictResolutionModal } from "./conflict-resolution-modal";
import { EmptyFolderCleanupModal } from "./empty-folder-cleanup-modal";
import { LocalDatabaseResetModal } from "./local-database-reset-modal";
import { NextcloudDeletionConfirmationModal } from "./nextcloud-deletion-confirmation-modal";
import { formatDateTime } from "./utils/date-format";
import { isLoggerLevel, Logger } from "./utils/logger";
import { isAndroidApp } from "./utils/platform";

const logger = new Logger("MySyncPlugin");

const IDLE_STATUS_DELAY_MS = 5000;
const ANDROID_NOMEDIA_PATH = ".nomedia";
const STRING_SETTING_KEYS = [
	"localVaultId",
	"localConflictDatabase",
	"customSyncFolder",
	"couchDbUrl",
	"couchDbDatabase",
	"couchDbUsername",
	"couchDbPassword",
	"nextcloudUrl",
	"nextcloudUsername",
	"nextcloudPassword",
	"nextcloudRemotePath",
	"lastSyncNowAt",
	"lastRemotePushAt",
	"lastRemotePullAt",
	"lastLocalDatabaseResetAt"
] as const;

interface SyncStatusView {
	text: string;
	title: string;
	returnToIdle?: boolean;
}

export default class MySyncPlugin extends Plugin {
	settings!: MySyncSettings;
	private syncService!: SyncService;
	private statusBarEl!: HTMLElement;
	private idleStatusTimer: number | null = null;
	private activeConflictCount = 0;
	private currentSyncStatus: SyncStatus = { state: "idle" };
	private conflictModal: ConflictResolutionModal | null = null;
	private emptyFolderCleanupModal: EmptyFolderCleanupModal | null = null;
	private localDatabaseResetModal: LocalDatabaseResetModal | null = null;

	async onload() {
		Logger.configureFileLogging(this.app.vault.adapter, this.getPluginDir());

		await this.loadSettings();
		await this.ensureAndroidNoMediaFile();

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addEventListener("click", () => void this.openConflictModal());
		this.updateSyncStatus({ state: "idle" });

		const fileStore = new PouchDbFileStore(createLocalDatabaseName(this.settings.localVaultId));
		const conflictStore = new PouchDbConflictStore(this.settings.localConflictDatabase);
		this.syncService = new SyncService(
			this.app,
			fileStore,
			conflictStore,
			() => this.settings,
			(status) => this.updateSyncStatus(status),
			(operation) => this.saveCompletedSyncOperation(operation),
			(conflicts) => this.handleConflictsChanged(conflicts),
			(details) => new Promise<boolean>((resolve) => {
				new NextcloudDeletionConfirmationModal(this.app, details, resolve).open();
			})
		);
		await this.syncService.initialize();

		this.addRibbonIcon("database-backup", "Sync local to remote", async () => {
			// await this.syncService.syncNow();
			await this.syncService.pushToRemote();
		});

		this.addRibbonIcon("file-up", "Push pending files to remote", async () => {
			await this.syncService.pushPendingFilesToRemote();
		});

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				void this.syncService.syncNow();
			}
		});

		this.addCommand({
			id: "push-to-remote",
			name: "Push to remote",
			callback: () => {
				void this.syncService.pushToRemote();
			}
		});

		this.addCommand({
			id: "push-pending-files-to-remote",
			name: "Push pending files to remote",
			callback: () => {
				void this.syncService.pushPendingFilesToRemote();
			}
		});

		this.addCommand({
			id: "pull-from-remote",
			name: "Pull from remote",
			callback: () => {
				void this.syncService.pullFromRemote();
			}
		});

		this.addCommand({
			id: "clean-empty-folders",
			name: "Clean empty folders",
			callback: () => {
				void this.openEmptyFolderCleanupModal();
			}
		});

		this.addCommand({
			id: "review-sync-conflicts",
			name: "Resolve sync conflicts",
			callback: () => {
				void this.openConflictModal();
			}
		});

		this.addCommand({
			id: "test-remote-connection",
			name: "Test remote connection",
			callback: () => {
				void this.syncService.testRemoteConnection();
			}
		});

		this.addSettingTab(new MySyncSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create",
					(file) => this.syncService.queueFileSync(file)
				)
			);

			this.registerEvent(
				this.app.vault.on("modify",
					(file) => this.syncService.queueFileSync(file)
				)
			);

			this.registerEvent(
				this.app.vault.on("rename",
					(file, oldPath) => void this.syncService.handleRenamedFile(file, oldPath)
				)
			);

			this.registerEvent(
				this.app.vault.on("delete",
					(file) => void this.syncService.handleDeletedFile(file)
				)
			);

		});
	}

	onunload() {
		this.clearIdleStatusTimer();
		this.conflictModal?.close();
		this.emptyFolderCleanupModal?.close();
		this.localDatabaseResetModal?.close();
		this.syncService.close();
		void Logger.flush();
		// Obsidian automatically disposes registered events, commands, and intervals.
	}

	async loadSettings() {
		const savedSettings = normalizeSavedSettings((await this.loadData()) as unknown);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
		Logger.setLevel(this.settings.logLevel);
		let settingsChanged = false;

		if (!this.settings.localVaultId) {
			this.settings.localVaultId = createLocalVaultId();
			settingsChanged = true;
		}

		const localDatabaseName = createLocalDatabaseName(this.settings.localVaultId);
		const expectedConflictDatabase = createConflictDatabaseName(localDatabaseName);

		if (this.settings.localConflictDatabase !== expectedConflictDatabase) {
			this.settings.localConflictDatabase = expectedConflictDatabase;
			settingsChanged = true;
		}

		if (settingsChanged) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	updateLogLevel(value: unknown) {
		if (!isLoggerLevel(value)) {
			return;
		}

		this.settings.logLevel = value;
		Logger.setLevel(value);
	}

	openLocalDatabaseResetModal() {
		if (this.localDatabaseResetModal) {
			return;
		}

		this.localDatabaseResetModal = new LocalDatabaseResetModal(
			this.app,
			createLocalDatabaseName(this.settings.localVaultId),
			this.settings.localConflictDatabase,
			() => this.syncService.resetLocalDatabases(),
			() => {
				this.localDatabaseResetModal = null;
			}
		);
		this.localDatabaseResetModal.open();
	}

	private openEmptyFolderCleanupModal() {
		if (this.emptyFolderCleanupModal || this.syncService.isRunning()) {
			return;
		}

		const folderCount = this.syncService.getEmptyVaultFolderCount();

		if (folderCount === 0) {
			new Notice("No empty folders found in the vault.");
			return;
		}

		this.emptyFolderCleanupModal = new EmptyFolderCleanupModal(
			this.app,
			folderCount,
			() => this.syncService.cleanEmptyVaultFolders(),
			() => {
				this.emptyFolderCleanupModal = null;
			}
		);
		this.emptyFolderCleanupModal.open();
	}

	private async saveCompletedSyncOperation(operation: CompletedSyncOperation) {
		const completedAt = new Date().toISOString();

		if (operation === "syncNow") {
			this.settings.lastSyncNowAt = completedAt;
		} else if (operation === "remotePush") {
			this.settings.lastRemotePushAt = completedAt;
		} else if (operation === "remotePull") {
			this.settings.lastRemotePullAt = completedAt;
		} else {
			this.settings.lastLocalDatabaseResetAt = completedAt;
		}

		await this.saveSettings();
	}

	private updateSyncStatus(status: SyncStatus) {
		this.currentSyncStatus = status;
		this.clearIdleStatusTimer();
		this.statusBarEl.empty();
		this.statusBarEl.addClass("mysync-status");

		const view = createSyncStatusView(status, this.settings);
		const conflictSuffix = this.activeConflictCount > 0
			? ` · ${this.activeConflictCount} conflict${this.activeConflictCount === 1 ? "" : "s"}`
			: "";
		this.statusBarEl.setText(`${view.text}${conflictSuffix}`);
		this.statusBarEl.title = `${view.title}${conflictSuffix}`;
		this.statusBarEl.toggleClass("mysync-status-has-conflicts", this.activeConflictCount > 0);

		if (view.returnToIdle) {
			this.scheduleIdleStatus();
		}
	}

	private handleConflictsChanged(conflicts: SyncConflict[]) {
		const previousCount = this.activeConflictCount;
		this.activeConflictCount = conflicts.length;
		this.updateSyncStatus(this.currentSyncStatus);

		this.conflictModal?.updateConflicts(conflicts);

		if (conflicts.length > previousCount) {
			window.setTimeout(() => {
				void this.openConflictModal();
			}, 250);
		}
	}

	private async openConflictModal() {
		const conflicts = await this.syncService.listActiveConflicts();

		if (conflicts.length === 0) {
			new Notice("There are no unresolved sync conflicts.");
			return;
		}

		if (this.conflictModal) {
			this.conflictModal.updateConflicts(conflicts);
			return;
		}

		this.conflictModal = new ConflictResolutionModal(
			this.app,
			conflicts,
			(conflictId, strategy) => this.syncService.resolveConflict(conflictId, strategy),
			(conflictId) => this.syncService.retryConflictPush(conflictId),
			() => {
				this.conflictModal = null;
			}
		);
		this.conflictModal.open();
	}

	private scheduleIdleStatus() {
		this.idleStatusTimer = window.setTimeout(() => {
			this.idleStatusTimer = null;
			this.updateSyncStatus({ state: "idle" });
		}, IDLE_STATUS_DELAY_MS);
	}

	private clearIdleStatusTimer() {
		if (this.idleStatusTimer === null) {
			return;
		}

		window.clearTimeout(this.idleStatusTimer);
		this.idleStatusTimer = null;
	}

	private getPluginDir() {
		return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}

	private async ensureAndroidNoMediaFile() {
		if (!isAndroidApp()) {
			return;
		}

		try {
			if (await this.app.vault.adapter.exists(ANDROID_NOMEDIA_PATH, true)) {
				return;
			}

			await this.app.vault.adapter.write(ANDROID_NOMEDIA_PATH, "");
		} catch (error) {
			logger.warn("Failed to create Android .nomedia file", error);
		}
	}
}

function createLocalVaultId() {
	if (typeof crypto.randomUUID === "function") {
		const [shortId] = crypto.randomUUID().split("-");
		if (shortId) {
			return shortId;
		}
	}

	const randomPart = typeof crypto.getRandomValues === "function"
		? Array.from(
			crypto.getRandomValues(new Uint8Array(4)),
			(byte) => byte.toString(16).padStart(2, "0")
		).join("")
		: Math.random().toString(36).slice(2, 10);

	return `${Date.now().toString(36)}-${randomPart}`;
}

function createLocalDatabaseName(localVaultId: string) {
	return `mysync-files-${localVaultId}`;
}

function createConflictDatabaseName(localDatabaseName: string) {
	const localDatabasePrefix = "mysync-files-";

	if (localDatabaseName.startsWith(localDatabasePrefix)) {
		return `mysync-conflicts-${localDatabaseName.slice(localDatabasePrefix.length)}`;
	}

	return `${localDatabaseName}-conflicts`;
}

function normalizeSavedSettings(data: unknown): Partial<MySyncSettings> {
	if (!isRecord(data)) {
		return {};
	}

	const settings: Partial<MySyncSettings> = {};

	for (const key of STRING_SETTING_KEYS) {
		const value = data[key];

		if (typeof value === "string") {
			settings[key] = value;
		}
	}


	if (typeof data["lastPushToCouchDbAt"] === "string" && !settings.lastRemotePushAt) {
		settings.lastRemotePushAt = data["lastPushToCouchDbAt"];
	}

	if (typeof data["lastPullFromCouchDbAt"] === "string" && !settings.lastRemotePullAt) {
		settings.lastRemotePullAt = data["lastPullFromCouchDbAt"];
	}

	if (isSyncFolderMode(data.syncFolderMode)) {
		settings.syncFolderMode = data.syncFolderMode;
	}

	if (typeof data.remoteBackend === "string" && isRemoteSyncBackend(data.remoteBackend)) {
		settings.remoteBackend = data.remoteBackend;
	}

	if (typeof data.syncObsidianConfig === "boolean") {
		settings.syncObsidianConfig = data.syncObsidianConfig;
	}

	if (isLoggerLevel(data.logLevel)) {
		settings.logLevel = data.logLevel;
	}

	return settings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSyncFolderMode(value: unknown): value is MySyncSettings["syncFolderMode"] {
	return value === "vault-root" || value === "custom";
}

function createSyncStatusView(status: SyncStatus, settings: MySyncSettings): SyncStatusView {
	switch (status.state) {
		case "idle": {
			const lastPushAt = formatDateTime(settings.lastRemotePushAt, { includeTime: true });

			return {
				text: lastPushAt ? lastPushAt : "...",
				title: "MySync last push"
			};
		}

		case "queued":
			return {
				text: `queued ${status.pending}`,
				title: `${status.pending} file(s) queued for sync`
			};

		case "syncing": {
			const percent = calculatePercent(status.current, status.total);

			return {
				text: `preparing ${percent}%`,
				title: `Saved ${status.saved}`
			};
		}

		case "done": {
			const text = `Saved ${status.saved}`;

			return {
				text,
				title: text,
				returnToIdle: true
			};
		}

		case "pushing": {
			if (typeof status.totalDocs === "number" && status.totalDocs > 0) {
				const percent = calculatePercent(status.docsWritten, status.totalDocs);
				return {
					text: `pushing ${percent}%`,
					title: `Processing remote operations (${status.docsWritten}/${status.totalDocs})`
				};
			}

			return {
				text: `pushing ${status.docsWritten}`,
				title: "Processing remote operations"
			};
		}

		case "pushed":
			return {
				text: `pushed ${status.docsWritten}`,
				title: "Push complete",
				returnToIdle: true
			};

		case "pulling":
			return {
				text: `reading ${status.docsRead}`,
				title: "Pulling from remote"
			};

		case "pulled":
			return {
				text: `restored ${status.restored}, deleted ${status.deleted}`,
				title: `Read ${status.docsRead}, restored ${status.restored}, deleted ${status.deleted}, skipped ${status.skipped}, conflicts ${status.conflicts}`,
				returnToIdle: true
			};

		case "cleaning-empty-folders":
			return {
				text: `cleaning ${status.current}/${status.total}`,
				title: `Removed ${status.removed}, skipped ${status.skipped}`
			};

		case "empty-folders-cleaned":
			return {
				text: `removed ${status.removed} folders`,
				title: `Removed ${status.removed} empty folder(s), skipped ${status.skipped}`,
				returnToIdle: true
			};

		case "resetting-local-databases":
			return {
				text: "resetting local data",
				title: "Resetting local MySync databases"
			};

		case "local-databases-reset":
			return {
				text: "local data reset",
				title: "Local MySync databases were reset",
				returnToIdle: true
			};

		case "deleting":
			return {
				text: `delete ${status.current}/${status.total}`,
				title: `Deleted ${status.deleted}, skipped ${status.skipped}, conflicts ${status.conflicts}`
			};

		case "restoring": {
			const percent = calculatePercent(status.current, status.total);

			return {
				text: `restoring ${percent}%`,
				title: `Restored ${status.restored}, skipped ${status.skipped}, conflicts ${status.conflicts}`
			};
		}

		case "testing":
			return {
				text: "testing",
				title: "Testing remote connection"
			};

		case "tested":
			return {
				text: "tested",
				title: `Connected to ${status.databaseName}`,
				returnToIdle: true
			};

		case "error":
			return {
				text: "MySync error",
				title: status.message,
				returnToIdle: true
			};

		default:
			return assertNever(status);
	}
}

function calculatePercent(current: number, total: number) {
	return total > 0
		? Math.round((current / total) * 100)
		: 0;
}

function assertNever(value: never): never {
	throw new Error(`Unhandled sync status: ${JSON.stringify(value)}`);
}
