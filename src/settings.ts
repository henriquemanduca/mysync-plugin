import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";
import type MySyncPlugin from "./main";
import { setDestructiveButton } from "./utils/button";
import { formatDateTime } from "./utils/date-format";
import type { LoggerLevel } from "./utils/logger";

export type SyncFolderMode = "vault-root" | "custom";
export type RemoteSyncBackend = "couchdb" | "nextcloud";

export interface MySyncSettings {
	localVaultId: string;
	localConflictDatabase: string;
	syncFolderMode: SyncFolderMode;
	customSyncFolder: string;
	syncObsidianConfig: boolean;
	remoteBackend: RemoteSyncBackend;
	couchDbUrl: string;
	couchDbDatabase: string;
	couchDbUsername: string;
	couchDbPassword: string;
	nextcloudUrl: string;
	nextcloudUsername: string;
	nextcloudPassword: string;
	nextcloudRemotePath: string;
	logLevel: LoggerLevel;
	lastSyncNowAt: string;
	lastPushToCouchDbAt: string;
	lastPullFromCouchDbAt: string;
	lastLocalDatabaseResetAt: string;
}

export const DEFAULT_SETTINGS: MySyncSettings = {
	localVaultId: "",
	localConflictDatabase: "",
	syncFolderMode: "vault-root",
	customSyncFolder: "",
	syncObsidianConfig: true,
	remoteBackend: "couchdb",
	couchDbUrl: "",
	couchDbDatabase: "mysync",
	couchDbUsername: "",
	couchDbPassword: "",
	nextcloudUrl: "",
	nextcloudUsername: "",
	nextcloudPassword: "",
	nextcloudRemotePath: "/",
	logLevel: "debug",
	lastSyncNowAt: "",
	lastPushToCouchDbAt: "",
	lastPullFromCouchDbAt: "",
	lastLocalDatabaseResetAt: ""
};

function isSyncFolderMode(value: string): value is SyncFolderMode {
	return value === "vault-root" || value === "custom";
}

export function isRemoteSyncBackend(value: string): value is RemoteSyncBackend {
	return value === "couchdb" || value === "nextcloud";
}

function refreshDomStateIfAvailable(settingTab: PluginSettingTab) {
	const refreshDomState = (settingTab as unknown as { refreshDomState?: () => void }).refreshDomState;
	refreshDomState?.call(settingTab);
}

export class MySyncSettingTab extends PluginSettingTab {
	plugin: MySyncPlugin;

	constructor(app: App, plugin: MySyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.renderLegacySettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Local configuration",
				cls: "mysync-settings-section",
				items: [
					{
						name: "Local file database",
						desc: "Automatically created database for files in this vault.",
						render: (setting) => {
							setting.addText((text) => {
								text.inputEl.readOnly = true;
								text.inputEl.addClass("mysync-readonly-setting");
								text.setValue(`mysync-files-${this.plugin.settings.localVaultId}`);
							});
						}
					},
					{
						name: "Local conflict database",
						desc: "Automatically created database for unresolved conflicts.",
						render: (setting) => {
							setting.addText((text) => {
								text.inputEl.readOnly = true;
								text.inputEl.addClass("mysync-readonly-setting");
								text.setValue(this.plugin.settings.localConflictDatabase);
							});
						}
					},
					{
						name: "Folder source",
						desc: `Choose what folder to sync. Current vault: ${this.app.vault.getName()}.`,
						control: {
							type: "dropdown",
							key: "syncFolderMode",
							options: {
								"vault-root": "Use Obsidian vault root",
								custom: "Set a custom folder"
							}
						}
					},
					{
						name: "Custom sync folder",
						desc: "Folder path inside the vault to sync when custom folder mode is selected.",
						control: {
							type: "text",
							key: "customSyncFolder",
							placeholder: "Projects/MySync",
							disabled: () => this.plugin.settings.syncFolderMode !== "custom"
						}
					},
					{
						name: "Sync Obsidian configuration",
						desc: "Synchronize top-level Obsidian configuration files (app.json, hotkeys.json, workspace.json).",
						control: {
							type: "toggle",
							key: "syncObsidianConfig"
						}
					},
					{
						name: "Obsidian configuration folder",
						desc: "Top-level files in this folder are included in synchronization when enabled.",
						render: (setting) => {
							setting.addText((text) => {
								text.inputEl.readOnly = true;
								text.inputEl.addClass("mysync-readonly-setting");
								text.setValue(this.app.vault.configDir);
							});
						}
					},
					{
						name: "Log level",
						desc: "Minimum level written to mysync.log. Errors are also written to the developer console.",
						control: {
							type: "dropdown",
							key: "logLevel",
							options: {
								debug: "Debug",
								log: "Log",
								info: "Info",
								warn: "Warnings",
								error: "Errors",
								off: "Off"
							}
						}
					},
					this.createReadonlyDateSetting(
						"Last sync now",
						"Last successful local sync execution.",
						"lastSyncNowAt"
					),
					this.createReadonlyDateSetting(
						"Last push to CouchDB",
						"Last successful remote push execution.",
						"lastPushToCouchDbAt"
					),
					this.createReadonlyDateSetting(
						"Last pull from CouchDB",
						"Last successful remote pull execution.",
						"lastPullFromCouchDbAt"
					)
				]
			},
			{
				type: "group",
				heading: "Local data",
				cls: "mysync-settings-section",
				items: [
					this.createReadonlyDateSetting(
						"Last local database reset",
						"Last time the local file and conflict databases were reset.",
						"lastLocalDatabaseResetAt"
					),
					{
						name: "Reset local databases",
						desc: "Delete the local file index, conflicts, revisions, baselines, and replication checkpoints. Vault files and remote CouchDB data are not changed.",
						render: (setting) => {
							setting.addButton((button) => {
								button.setButtonText("Reset local databases");
								setDestructiveButton(button)
									.onClick(() => this.plugin.openLocalDatabaseResetModal());
							});
						}
					}
				]
			},
			{
				type: "group",
				heading: "Remote database",
				cls: "mysync-settings-section",
				items: [
					{
						name: "Remote synchronization backend",
						desc: "Choose the backend service to sync your files to.",
						control: {
							type: "dropdown",
							key: "remoteBackend",
							options: {
								couchdb: "CouchDB",
								nextcloud: "Nextcloud"
							}
						}
					},
					{
						name: "CouchDB URL",
						desc: "Base URL for the CouchDB server.",
						control: {
							type: "text",
							key: "couchDbUrl",
							placeholder: "https://couchdb.example.com"
						}
					},
					{
						name: "CouchDB database",
						desc: "Database name used for remote sync.",
						control: {
							type: "text",
							key: "couchDbDatabase",
							placeholder: "mysync"
						}
					},
					{
						name: "CouchDB username",
						desc: "Username for CouchDB basic authentication.",
						control: {
							type: "text",
							key: "couchDbUsername",
							placeholder: "username"
						}
					},
					{
						name: "CouchDB password",
						desc: "Password for CouchDB basic authentication.",
						render: (setting) => {
							setting.addText((text) => {
								text.inputEl.type = "password";
								text
									.setPlaceholder("Password")
									.setValue(this.plugin.settings.couchDbPassword)
									.onChange(async (value) => {
										this.plugin.settings.couchDbPassword = value;
										await this.plugin.saveSettings();
									});
							});
						}
					},
					{
						name: "Nextcloud URL",
						desc: "Base URL for the Nextcloud server (e.g., https://cloud.example.com).",
						control: {
							type: "text",
							key: "nextcloudUrl",
							placeholder: "https://cloud.example.com"
						}
					},
					{
						name: "Nextcloud username",
						desc: "Username for Nextcloud login.",
						control: {
							type: "text",
							key: "nextcloudUsername",
							placeholder: "username"
						}
					},
					{
						name: "Nextcloud App Password",
						desc: "Use an App Password generated in your Nextcloud security settings, NOT your main password.",
						render: (setting) => {
							setting.addText((text) => {
								text.inputEl.type = "password";
								text
									.setPlaceholder("App Password")
									.setValue(this.plugin.settings.nextcloudPassword)
									.onChange(async (value) => {
										this.plugin.settings.nextcloudPassword = value;
										await this.plugin.saveSettings();
									});
							});
						}
					},
					{
						name: "Nextcloud Remote Path",
						desc: "Directory in Nextcloud where files will be synced (e.g., /Notes).",
						control: {
							type: "text",
							key: "nextcloudRemotePath",
							placeholder: "/Notes"
						}
					}
				]
			}
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof MySyncSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case "syncFolderMode": {
				const syncFolderMode = String(value);

				if (!isSyncFolderMode(syncFolderMode)) {
					return;
				}

				this.plugin.settings.syncFolderMode = syncFolderMode;
				await this.plugin.saveSettings();
				refreshDomStateIfAvailable(this);
				return;
			}
			case "remoteBackend": {
				const remoteBackend = String(value);
				if (!isRemoteSyncBackend(remoteBackend)) {
					return;
				}
				this.plugin.settings.remoteBackend = remoteBackend;
				await this.plugin.saveSettings();
				refreshDomStateIfAvailable(this);
				return;
			}
			case "customSyncFolder":
				this.plugin.settings.customSyncFolder = String(value).trim();
				break;
			case "syncObsidianConfig":
				this.plugin.settings.syncObsidianConfig = Boolean(value);
				break;
			case "couchDbUrl":
				this.plugin.settings.couchDbUrl = String(value).trim().replace(/\/+$/g, "");
				break;
			case "couchDbDatabase":
				this.plugin.settings.couchDbDatabase = String(value).trim();
				break;
			case "couchDbUsername":
				this.plugin.settings.couchDbUsername = String(value).trim();
				break;
			case "nextcloudUrl":
				this.plugin.settings.nextcloudUrl = String(value).trim().replace(/\/+$/g, "");
				break;
			case "nextcloudUsername":
				this.plugin.settings.nextcloudUsername = String(value).trim();
				break;
			case "nextcloudRemotePath":
				this.plugin.settings.nextcloudRemotePath = String(value).trim();
				break;
			case "logLevel":
				this.plugin.updateLogLevel(value);
				break;
			default:
				return;
		}

		await this.plugin.saveSettings();
	}

	private createReadonlyDateSetting(
		name: string,
		desc: string,
		key:
			| "lastSyncNowAt"
			| "lastPushToCouchDbAt"
			| "lastPullFromCouchDbAt"
			| "lastLocalDatabaseResetAt"
	): SettingGroupItem {
		return {
			name,
			desc,
			render: (setting) => {
				const value = this.plugin.settings[key];

				setting.addText((text) => {
					text.inputEl.readOnly = true;
					text.inputEl.addClass("mysync-readonly-setting");
					text.setValue(formatDateTime(value, {
						fallback: "Never",
						invalidFallback: value
					}));
				});
			}
		};
	}

	private createLegacySection(name: string): HTMLElement {
		const sectionEl = this.containerEl.createDiv({ cls: "mysync-settings-section" });
		new Setting(sectionEl).setName(name).setHeading();
		return sectionEl;
	}

	private renderLegacySettings(): void {
		const { containerEl } = this;
		containerEl.empty();

		const localSectionEl = this.createLegacySection("Local configuration");
		const localDataSectionEl = this.createLegacySection("Local data");
		const remoteSectionEl = this.createLegacySection("Remote database");

		new Setting(localSectionEl)
			.setName("Local file database")
			.setDesc("Automatically created database for files in this vault.")
			.addText((text) => {
				text.inputEl.readOnly = true;
				text.inputEl.addClass("mysync-readonly-setting");
				text.setValue(`mysync-files-${this.plugin.settings.localVaultId}`);
			});

		new Setting(localSectionEl)
			.setName("Local conflict database")
			.setDesc("Automatically created database for unresolved conflicts.")
			.addText((text) => {
				text.inputEl.readOnly = true;
				text.inputEl.addClass("mysync-readonly-setting");
				text.setValue(this.plugin.settings.localConflictDatabase);
			});

		new Setting(localSectionEl)
			.setName("Folder source")
			.setDesc(`Choose what folder to sync. Current vault: ${this.app.vault.getName()}.`)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("vault-root", "Use Obsidian vault root")
					.addOption("custom", "Set a custom folder")
					.setValue(this.plugin.settings.syncFolderMode)
					.onChange(async (value) => {
						if (!isSyncFolderMode(value)) {
							return;
						}

						this.plugin.settings.syncFolderMode = value;
						await this.plugin.saveSettings();
						this.renderLegacySettings();
					})
			);

		new Setting(localSectionEl)
			.setName("Custom sync folder")
			.setDesc("Folder path inside the vault to sync when custom folder mode is selected.")
			.addText((text) =>
				text
					.setPlaceholder("Projects/MySync")
					.setValue(this.plugin.settings.customSyncFolder)
					.setDisabled(this.plugin.settings.syncFolderMode !== "custom")
					.onChange(async (value) => {
						this.plugin.settings.customSyncFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(localSectionEl)
			.setName("Sync Obsidian configuration")
			.setDesc("Synchronize top-level Obsidian configuration files (app.json, hotkeys.json, workspace.json).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncObsidianConfig)
					.onChange(async (value) => {
						this.plugin.settings.syncObsidianConfig = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(localSectionEl)
			.setName("Obsidian configuration folder")
			.setDesc("Top-level files in this folder are included in synchronization when enabled.")
			.addText((text) => {
				text.inputEl.readOnly = true;
				text.inputEl.addClass("mysync-readonly-setting");
				text.setValue(this.app.vault.configDir);
			});

		new Setting(localSectionEl)
			.setName("Log level")
			.setDesc("Minimum level written to mysync.log. Errors are also written to the developer console.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("debug", "Debug")
					.addOption("log", "Log")
					.addOption("info", "Info")
					.addOption("warn", "Warnings")
					.addOption("error", "Errors")
					.addOption("off", "Off")
					.setValue(this.plugin.settings.logLevel)
					.onChange(async (value) => {
						this.plugin.updateLogLevel(value);
						await this.plugin.saveSettings();
					})
			);

		this.addReadonlyLegacyDateSetting(
			localSectionEl,
			"Last sync now",
			"Last successful local sync execution.",
			this.plugin.settings.lastSyncNowAt
		);
		this.addReadonlyLegacyDateSetting(
			localSectionEl,
			"Last push to CouchDB",
			"Last successful remote push execution.",
			this.plugin.settings.lastPushToCouchDbAt
		);
		this.addReadonlyLegacyDateSetting(
			localSectionEl,
			"Last pull from CouchDB",
			"Last successful remote pull execution.",
			this.plugin.settings.lastPullFromCouchDbAt
		);

		this.addReadonlyLegacyDateSetting(
			localDataSectionEl,
			"Last local database reset",
			"Last time the local file and conflict databases were reset.",
			this.plugin.settings.lastLocalDatabaseResetAt
		);

		new Setting(localDataSectionEl)
			.setName("Reset local databases")
			.setDesc("Delete the local file index, conflicts, revisions, baselines, and replication checkpoints. Vault files and remote CouchDB data are not changed.")
			.addButton((button) => {
				button.setButtonText("Reset local databases");
				setDestructiveButton(button)
					.onClick(() => this.plugin.openLocalDatabaseResetModal());
			});

		new Setting(remoteSectionEl)
			.setName("Remote synchronization backend")
			.setDesc("Choose the backend service to sync your files to.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("couchdb", "CouchDB")
					.addOption("nextcloud", "Nextcloud")
					.setValue(this.plugin.settings.remoteBackend)
					.onChange(async (value) => {
						if (!isRemoteSyncBackend(value)) {
							return;
						}

						this.plugin.settings.remoteBackend = value;
						await this.plugin.saveSettings();
						this.renderLegacySettings();
					})
			);

		if (this.plugin.settings.remoteBackend === "couchdb") {
			new Setting(remoteSectionEl)
				.setName("CouchDB URL")
				.setDesc("Base URL for the CouchDB server.")
				.addText((text) =>
					text
						.setPlaceholder("https://couchdb.example.com")
						.setValue(this.plugin.settings.couchDbUrl)
						.onChange(async (value) => {
							this.plugin.settings.couchDbUrl = value.trim().replace(/\/+$/g, "");
							await this.plugin.saveSettings();
						})
				);

			new Setting(remoteSectionEl)
				.setName("CouchDB database")
				.setDesc("Database name used for remote sync.")
				.addText((text) =>
					text
						.setPlaceholder("mysync")
						.setValue(this.plugin.settings.couchDbDatabase)
						.onChange(async (value) => {
							this.plugin.settings.couchDbDatabase = value.trim();
							await this.plugin.saveSettings();
						})
				);

			new Setting(remoteSectionEl)
				.setName("CouchDB username")
				.setDesc("Username for CouchDB basic authentication.")
				.addText((text) =>
					text
						.setPlaceholder("username")
						.setValue(this.plugin.settings.couchDbUsername)
						.onChange(async (value) => {
							this.plugin.settings.couchDbUsername = value.trim();
							await this.plugin.saveSettings();
						})
				);

			new Setting(remoteSectionEl)
				.setName("CouchDB password")
				.setDesc("Password for CouchDB basic authentication.")
				.addText((text) => {
					text.inputEl.type = "password";
					text
						.setPlaceholder("Password")
						.setValue(this.plugin.settings.couchDbPassword)
						.onChange(async (value) => {
							this.plugin.settings.couchDbPassword = value;
							await this.plugin.saveSettings();
						});
				});
		} else if (this.plugin.settings.remoteBackend === "nextcloud") {
			new Setting(remoteSectionEl)
				.setName("Nextcloud URL")
				.setDesc("Base URL for the Nextcloud server (e.g., https://cloud.example.com).")
				.addText((text) =>
					text
						.setPlaceholder("https://cloud.example.com")
						.setValue(this.plugin.settings.nextcloudUrl)
						.onChange(async (value) => {
							this.plugin.settings.nextcloudUrl = value.trim().replace(/\/+$/g, "");
							await this.plugin.saveSettings();
						})
				);

			new Setting(remoteSectionEl)
				.setName("Nextcloud username")
				.setDesc("Username for Nextcloud login.")
				.addText((text) =>
					text
						.setPlaceholder("username")
						.setValue(this.plugin.settings.nextcloudUsername)
						.onChange(async (value) => {
							this.plugin.settings.nextcloudUsername = value.trim();
							await this.plugin.saveSettings();
						})
				);

			new Setting(remoteSectionEl)
				.setName("Nextcloud App Password")
				.setDesc("Use an App Password generated in your Nextcloud security settings, NOT your main password.")
				.addText((text) => {
					text.inputEl.type = "password";
					text
						.setPlaceholder("App Password")
						.setValue(this.plugin.settings.nextcloudPassword)
						.onChange(async (value) => {
							this.plugin.settings.nextcloudPassword = value;
							await this.plugin.saveSettings();
						});
				});

			new Setting(remoteSectionEl)
				.setName("Nextcloud Remote Path")
				.setDesc("Directory in Nextcloud where files will be synced (e.g., /Notes).")
				.addText((text) =>
					text
						.setPlaceholder("/Notes")
						.setValue(this.plugin.settings.nextcloudRemotePath)
						.onChange(async (value) => {
							this.plugin.settings.nextcloudRemotePath = value.trim();
							await this.plugin.saveSettings();
						})
				);
		}
	}

	private addReadonlyLegacyDateSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		value: string
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) => {
				text.inputEl.readOnly = true;
				text.inputEl.addClass("mysync-readonly-setting");
				text.setValue(formatDateTime(value, {
					fallback: "Never",
					invalidFallback: value
				}));
			});
	}
}
