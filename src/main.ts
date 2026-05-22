import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, MySyncSettingTab, type MySyncSettings } from "settings";
import { PouchDbFileStore } from "sync/pouchdb-store";
import { SyncService, type SyncStatus } from "sync/sync-service";
import { Logger } from 'utils/logger';

const logger = new Logger("MySyncPlugin");

export default class MySyncPlugin extends Plugin {
	settings!: MySyncSettings;
	private syncService!: SyncService;
	private statusBarEl!: HTMLElement;

	async onload() {
		await this.loadSettings();
		logger.method('onload', { settings: this.settings });

		this.statusBarEl = this.addStatusBarItem();
		this.updateSyncStatus({ state: "idle" });

		const fileStore = new PouchDbFileStore(createLocalDatabaseName(this.settings.localVaultId));
		this.syncService = new SyncService(this.app, fileStore, () => this.settings, (status) =>
			this.updateSyncStatus(status)
		);

		this.addRibbonIcon("refresh-cw", "Sync local to remote", async () => {
			await this.syncService.syncNow();
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
		this.syncService.close();
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

	private updateSyncStatus(status: SyncStatus) {
		this.statusBarEl.empty();
		this.statusBarEl.addClass("mysync-status");

		if (status.state === "idle") {
			this.statusBarEl.setText("idle");
			this.statusBarEl.title = "MySync is idle";
			return;
		}

		if (status.state === "queued") {
			this.statusBarEl.setText(`queued ${status.pending}`);
			this.statusBarEl.title = `${status.pending} file(s) queued for sync`;
			return;
		}

		if (status.state === "syncing") {
			this.statusBarEl.setText(`local ${status.current}/${status.total}`);
			this.statusBarEl.title = `Syncing local files. Saved ${status.saved}, skipped ${status.skipped}`;
			return;
		}

		if (status.state === "done") {
    		this.statusBarEl.setText("done");
			this.statusBarEl.title = `Saved ${status.saved}, skipped ${status.skipped}`;
			return;
		}

		if (status.state === "pushing") {
			this.statusBarEl.setText("pushing");
			this.statusBarEl.title = "Pushing to remote.";
			return;
		}

		if (status.state === "pushed") {
			this.statusBarEl.setText("pushed");
			this.statusBarEl.title = "Push complete.";
			return;
		}

		if (status.state === "pulling") {
			this.statusBarEl.setText("pulling");
			this.statusBarEl.title = "Pulling from CouchDB.";
			return;
		}

		if (status.state === "deleting") {
			this.statusBarEl.setText(`delete ${status.current}/${status.total}`);
			this.statusBarEl.title = `Applying remote deletions. Deleted ${status.deleted}, skipped ${status.skipped}, conflicts ${status.conflicts}`;
			return;
		}

		if (status.state === "restoring") {
			this.statusBarEl.setText(`restore ${status.current}, skipped ${status.skipped}`);
			this.statusBarEl.title = `Restoring files. Restored ${status.restored}, skipped ${status.skipped}, conflicts ${status.conflicts}`;
			return;
		}

		if (status.state === "pulled") {
			this.statusBarEl.setText(`pulled ${status.restored}/${status.deleted}`);
			this.statusBarEl.title = `Pull complete. Read ${status.docsRead}, restored ${status.restored}, deleted ${status.deleted}, skipped ${status.skipped}, conflicts ${status.conflicts}`;
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
			return;
		}

		this.statusBarEl.setText("MySync error");
		this.statusBarEl.title = status.message;
	}
}

function createLocalVaultId() {
	return crypto.randomUUID().split("-")[0] ||
		`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function createLocalDatabaseName(localVaultId: string) {
	return `mysync-files-${localVaultId}`;
}
