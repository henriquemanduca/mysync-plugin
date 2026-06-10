import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, MySyncSettingTab, type MySyncSettings } from "settings";
import { PouchDbFileStore } from "sync/pouchdb-store";
import { SyncService, type SyncStatus } from "sync/sync-service";
import { Logger } from "utils/logger";

const logger = new Logger("MySyncPlugin");
const IDLE_STATUS_DELAY_MS = 5000;

export default class MySyncPlugin extends Plugin {
	settings!: MySyncSettings;
	private syncService!: SyncService;
	private statusBarEl!: HTMLElement;
	private idleStatusTimer: number | null = null;

	async onload() {
		Logger.configureFileLogging(this.app.vault.adapter, this.getPluginDir());
		await this.loadSettings();

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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		if (!this.settings.localVaultId) {
			this.settings.localVaultId = createLocalVaultId();
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
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

		if (status.state === "idle") {
			this.statusBarEl.setText("...");
			this.statusBarEl.title = "MySync is idle";
			return;
		}

		if (status.state === "queued") {
			this.statusBarEl.setText(`queued ${status.pending}`);
			this.statusBarEl.title = `${status.pending} file(s) queued for sync`;
			return;
		}

		if (status.state === "syncing") {
			const percent = status.total > 0
				? Math.round((status.current / status.total) * 100)
				: 0;
			this.statusBarEl.setText(`preparing ${percent}%`);
			this.statusBarEl.title = `Saved ${status.saved}, skipped ${status.skipped}`;
			return;
		}

		if (status.state === "done") {
			const text = `Saved ${status.saved}, skipped ${status.skipped}`
			this.statusBarEl.setText(text);
			this.statusBarEl.title = text;
			this.scheduleIdleStatus();
			return;
		}

		if (status.state === "pushing") {
			this.statusBarEl.setText(`pushing ${status.docsWritten}`);
			this.statusBarEl.title = "Pushing to remote";
			return;
		}

		if (status.state === "pushed") {
			this.statusBarEl.setText(`pushed ${status.docsWritten}`);
			this.statusBarEl.title = "Push complete";
			this.scheduleIdleStatus();
			return;
		}

		if (status.state === "pulling") {
			this.statusBarEl.setText(`reading ${status.docsRead}`);
			this.statusBarEl.title = "Pulling from remote";
			return;
		}

		if (status.state === "pulled") {
			this.statusBarEl.setText(`restored ${status.restored}, deleted ${status.deleted}`);
			this.statusBarEl.title = `Read ${status.docsRead}, restored ${status.restored}, deleted ${status.deleted}, skipped ${status.skipped}, conflicts ${status.conflicts}`;
			this.scheduleIdleStatus();
			return;
		}

		if (status.state === "deleting") {
			this.statusBarEl.setText(`delete ${status.current}/${status.total}`);
			this.statusBarEl.title = `Deleted ${status.deleted}, skipped ${status.skipped}, conflicts ${status.conflicts}`;
			return;
		}

		if (status.state === "restoring") {
			const percent = status.total > 0
				? Math.round((status.current / status.total) * 100)
				: 0;
			this.statusBarEl.setText(`restoring ${percent}%`);
			this.statusBarEl.title = `Restored ${status.restored}, skipped ${status.skipped}, conflicts ${status.conflicts}`;
			return;
		}

		if (status.state === "testing") {
			this.statusBarEl.setText("testing");
			this.statusBarEl.title = "Testing remote connection";
			return;
		}

		if (status.state === "tested") {
			this.statusBarEl.setText("tested");
			this.statusBarEl.title = `Connected to ${status.databaseName}`;
			this.scheduleIdleStatus();
			return;
		}

		this.statusBarEl.setText("MySync error");
		this.statusBarEl.title = status.message;
		this.scheduleIdleStatus();
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
}

function createLocalVaultId() {
	return crypto.randomUUID().split("-")[0] ||
		`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function createLocalDatabaseName(localVaultId: string) {
	return `mysync-files-${localVaultId}`;
}
