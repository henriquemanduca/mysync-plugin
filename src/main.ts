import { Notice, Plugin } from "obsidian";
import type { CompletedSyncOperation, MySyncSettings, SyncConflict, SyncStatus } from "./core";
import { MySyncSettingTab } from "./ui/settings/settings-tab";
import {
	SettingsRepository,
	createConflictDatabaseName,
	createLocalDatabaseName
} from "./ui/settings/settings-repository";
import { StatusBarController } from "./ui/status-bar/status-bar-controller";
import { ConflictResolutionModal } from "./ui/modals/conflict-resolution-modal";
import { EmptyFolderCleanupModal } from "./ui/modals/empty-folder-cleanup-modal";
import { LocalDatabaseResetModal } from "./ui/modals/local-database-reset-modal";
import { NextcloudDeletionConfirmationModal } from "./ui/modals/nextcloud-deletion-confirmation-modal";
import { PouchDbFileStore } from "./sync/pouchdb-store";
import { PouchDbConflictStore } from "./sync/conflict-store";
import { SyncService } from "./sync/sync-service";
import { isLoggerLevel, Logger } from "./utils/logger";

export default class MySyncPlugin extends Plugin {
	settings!: MySyncSettings;
	private settingsRepository!: SettingsRepository;
	private syncService!: SyncService;
	private statusBarController!: StatusBarController;
	private conflictModal: ConflictResolutionModal | null = null;
	private emptyFolderCleanupModal: EmptyFolderCleanupModal | null = null;
	private localDatabaseResetModal: LocalDatabaseResetModal | null = null;
	private activeConflictCount = 0;

	async onload() {
		Logger.configureFileLogging(this.app.vault.adapter, this.getPluginDir());

		this.settingsRepository = new SettingsRepository(this);
		this.settings = await this.settingsRepository.loadSettings();
		await this.settingsRepository.ensureAndroidNoMediaFile();

		this.statusBarController = new StatusBarController(
			this.addStatusBarItem(),
			() => this.settings,
			() => void this.openConflictModal()
		);

		const fileStore = new PouchDbFileStore(createLocalDatabaseName(this.settings.localVaultId));
		const conflictStore = new PouchDbConflictStore(this.settings.localConflictDatabase);

		this.syncService = new SyncService(
			this.app,
			fileStore,
			conflictStore,
			() => this.settings,
			(status) => this.statusBarController.updateSyncStatus(status),
			(operation) => this.saveCompletedSyncOperation(operation),
			(conflicts) => this.handleConflictsChanged(conflicts),
			(details) => new Promise<boolean>((resolve) => {
				new NextcloudDeletionConfirmationModal(this.app, details, resolve).open();
			})
		);
		await this.syncService.initialize();

		this.registerRibbonActions();
		this.registerCommands();
		this.addSettingTab(new MySyncSettingTab(this.app, this));
		this.registerVaultEvents();
	}

	onunload() {
		this.statusBarController?.destroy();
		this.conflictModal?.close();
		this.emptyFolderCleanupModal?.close();
		this.localDatabaseResetModal?.close();
		this.syncService?.close();
		void Logger.flush();
	}

	async loadSettings() {
		this.settings = await this.settingsRepository.loadSettings();
	}

	async saveSettings() {
		await this.settingsRepository.saveSettings(this.settings);
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

	openEmptyFolderCleanupModal() {
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

	async openConflictModal() {
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

	private registerRibbonActions() {
		this.addRibbonIcon("database-backup", "Sync local to remote", async () => {
			await this.syncService.pushToRemote();
		});

		this.addRibbonIcon("file-up", "Push pending files to remote", async () => {
			await this.syncService.pushPendingFilesToRemote();
		});
	}

	private registerCommands() {
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
	}

	private registerVaultEvents() {
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create", (file) => this.syncService.queueFileSync(file))
			);
			this.registerEvent(
				this.app.vault.on("modify", (file) => this.syncService.queueFileSync(file))
			);
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => void this.syncService.handleRenamedFile(file, oldPath))
			);
			this.registerEvent(
				this.app.vault.on("delete", (file) => void this.syncService.handleDeletedFile(file))
			);
		});
	}

	private handleConflictsChanged(conflicts: SyncConflict[]) {
		const previousCount = this.activeConflictCount;
		this.activeConflictCount = conflicts.length;
		this.statusBarController.updateConflictCount(conflicts.length);
		this.conflictModal?.updateConflicts(conflicts);

		if (conflicts.length > previousCount) {
			window.setTimeout(() => {
				void this.openConflictModal();
			}, 250);
		}
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

	private getPluginDir(): string {
		return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}
}
