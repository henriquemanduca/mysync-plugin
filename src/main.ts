import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, MySyncSettingTab, type MySyncSettings } from "settings";
import { PouchDbFileStore } from "sync/pouchdb-store";
import { SyncService, type CompletedSyncOperation, type SyncStatus } from "sync/sync-service";
import { formatDateTime } from "utils/date-format";
import { isLoggerLevel, Logger } from "utils/logger";
import { isAndroidApp } from "utils/platform";

const logger = new Logger("MySyncPlugin");

const IDLE_STATUS_DELAY_MS = 5000;
const ANDROID_NOMEDIA_PATH = ".nomedia";
const STRING_SETTING_KEYS = [
	"localVaultId",
	"customSyncFolder",
	"couchDbUrl",
	"couchDbDatabase",
	"couchDbUsername",
	"couchDbPassword",
	"lastSyncNowAt",
	"lastPushToCouchDbAt",
	"lastPullFromCouchDbAt"
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

	async onload() {
		Logger.configureFileLogging(this.app.vault.adapter, this.getPluginDir());
		await this.loadSettings();
		await this.ensureAndroidNoMediaFile();

		this.statusBarEl = this.addStatusBarItem();
		this.updateSyncStatus({ state: "idle" });

		const fileStore = new PouchDbFileStore(createLocalDatabaseName(this.settings.localVaultId));
		this.syncService = new SyncService(
			this.app,
			fileStore,
			() => this.settings,
			(status) => this.updateSyncStatus(status),
			(operation) => this.saveCompletedSyncOperation(operation)
		);

		this.addRibbonIcon("database-backup", "Sync local to remote", async () => {
			// await this.syncService.syncNow();
			await this.syncService.pushToCouchDb();
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
				void this.syncService.pushToCouchDb();
			}
		});

		this.addCommand({
			id: "pull-from-remote",
			name: "Pull from remote",
			callback: () => {
				void this.syncService.pullFromCouchDb();
			}
		});

		this.addCommand({
			id: "test-remote-connection",
			name: "Test remote connection",
			callback: () => {
				void this.syncService.testCouchDbConnection();
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

			if (this.settings.syncOnStartup) {
				void this.syncService.syncNow();
			}
		});
	}

	onunload() {
		this.clearIdleStatusTimer();
		this.syncService.close();
		void Logger.flush();
		// Obsidian automatically disposes registered events, commands, and intervals.
	}

	async loadSettings() {
		const savedSettings = normalizeSavedSettings((await this.loadData()) as unknown);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
		Logger.setLevel(this.settings.logLevel);

		if (!this.settings.localVaultId) {
			this.settings.localVaultId = createLocalVaultId();
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

	private async saveCompletedSyncOperation(operation: CompletedSyncOperation) {
		const completedAt = new Date().toISOString();

		if (operation === "syncNow") {
			this.settings.lastSyncNowAt = completedAt;
		} else if (operation === "pushToCouchDb") {
			this.settings.lastPushToCouchDbAt = completedAt;
		} else {
			this.settings.lastPullFromCouchDbAt = completedAt;
		}

		await this.saveSettings();
	}

	private updateSyncStatus(status: SyncStatus) {
		this.clearIdleStatusTimer();
		this.statusBarEl.empty();
		this.statusBarEl.addClass("mysync-status");

		const view = createSyncStatusView(status, this.settings);
		this.statusBarEl.setText(view.text);
		this.statusBarEl.title = view.title;

		if (view.returnToIdle) {
			this.scheduleIdleStatus();
		}
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

	if (isSyncFolderMode(data.syncFolderMode)) {
		settings.syncFolderMode = data.syncFolderMode;
	}

	if (typeof data.syncOnStartup === "boolean") {
		settings.syncOnStartup = data.syncOnStartup;
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
			const lastPushAt = formatDateTime(settings.lastPushToCouchDbAt, { includeTime: true });

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
				title: `Saved ${status.saved}, skipped ${status.skipped}`
			};
		}

		case "done": {
			const text = `Saved ${status.saved}, skipped ${status.skipped}`;

			return {
				text,
				title: text,
				returnToIdle: true
			};
		}

		case "pushing":
			return {
				text: `pushing ${status.docsWritten}`,
				title: "Pushing to remote"
			};

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
