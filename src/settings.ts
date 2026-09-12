import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";
import type MySyncPlugin from "./main";
import { setDestructiveButton } from "./utils/button";
import { formatDateTime } from "./utils/date-format";
import type { LoggerLevel } from "./utils/logger";
import { normalizeOpenCloudSpaceId } from "./sync/opencloud-path";

export type SyncFolderMode = "vault-root" | "custom";
export type RemoteSyncBackend = "couchdb" | "nextcloud" | "opencloud";
export type OpenCloudAuthType = "app-token" | "bearer";

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
	opencloudUrl: string;
	opencloudSpaceId: string;
	opencloudAuthType: OpenCloudAuthType;
	opencloudUsername: string;
	opencloudToken: string;
	opencloudRemotePath: string;
	opencloudTusChunkSizeMb: number;
	logLevel: LoggerLevel;
	lastSyncNowAt: string;
	lastRemotePushAt: string;
	lastRemotePullAt: string;
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
	opencloudUrl: "",
	opencloudSpaceId: "",
	opencloudAuthType: "app-token",
	opencloudUsername: "",
	opencloudToken: "",
	opencloudRemotePath: "/",
	opencloudTusChunkSizeMb: 5,
	logLevel: "debug",
	lastSyncNowAt: "",
	lastRemotePushAt: "",
	lastRemotePullAt: "",
	lastLocalDatabaseResetAt: ""
};

function isSyncFolderMode(value: string): value is SyncFolderMode {
	return value === "vault-root" || value === "custom";
}

export function isRemoteSyncBackend(value: string): value is RemoteSyncBackend {
	return value === "couchdb" || value === "nextcloud" || value === "opencloud";
}

export function isOpenCloudAuthType(value: string): value is OpenCloudAuthType {
	return value === "app-token" || value === "bearer";
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
						"Last push to remote",
						"Last successful remote push execution.",
						"lastRemotePushAt"
					),
					this.createReadonlyDateSetting(
						"Last pull from remote",
						"Last successful remote pull execution.",
						"lastRemotePullAt"
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
						desc: "Delete the local file index, conflicts, revisions, baselines, and replication checkpoints. Vault files and remote data are not changed.",
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
								nextcloud: "Nextcloud",
								opencloud: "OpenCloud"
							}
						}
					},
					{
						name: "CouchDB URL",
						desc: "Base URL for the CouchDB server.",
						visible: () => this.plugin.settings.remoteBackend === "couchdb",
						control: {
							type: "text",
							key: "couchDbUrl",
							placeholder: "https://couchdb.example.com"
						}
					},
					{
						name: "CouchDB database",
						desc: "Database name used for remote sync.",
						visible: () => this.plugin.settings.remoteBackend === "couchdb",
						control: {
							type: "text",
							key: "couchDbDatabase",
							placeholder: "mysync"
						}
					},
					{
						name: "CouchDB username",
						desc: "Username for CouchDB basic authentication.",
						visible: () => this.plugin.settings.remoteBackend === "couchdb",
						control: {
							type: "text",
							key: "couchDbUsername",
							placeholder: "username"
						}
					},
					{
						name: "CouchDB password",
						desc: "Password for CouchDB basic authentication.",
						visible: () => this.plugin.settings.remoteBackend === "couchdb",
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
						visible: () => this.plugin.settings.remoteBackend === "nextcloud",
						control: {
							type: "text",
							key: "nextcloudUrl",
							placeholder: "https://cloud.example.com"
						}
					},
					{
						name: "Nextcloud username",
						desc: "Username for Nextcloud login.",
						visible: () => this.plugin.settings.remoteBackend === "nextcloud",
						control: {
							type: "text",
							key: "nextcloudUsername",
							placeholder: "username"
						}
					},
					{
						name: "Nextcloud App Password",
						desc: "Use an App Password generated in your Nextcloud security settings, NOT your main password.",
						visible: () => this.plugin.settings.remoteBackend === "nextcloud",
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
						visible: () => this.plugin.settings.remoteBackend === "nextcloud",
						control: {
							type: "text",
							key: "nextcloudRemotePath",
							placeholder: "/Notes"
						}
					},
					{
						name: "OpenCloud URL",
						desc: "Base URL for the OpenCloud server (e.g., https://cloud.example.com).",
						visible: () => this.plugin.settings.remoteBackend === "opencloud",
						control: {
							type: "text",
							key: "opencloudUrl",
							placeholder: "https://cloud.example.com"
						}
					},
					{
						name: "OpenCloud Space ID",
						desc: "Resource ID from the Space WebDAV URL.",
						visible: () => this.plugin.settings.remoteBackend === "opencloud",
						control: {
							type: "text",
							key: "opencloudSpaceId",
							placeholder: "storage-id$space-id"
						}
					},
					{
						name: "OpenCloud authentication",
						desc: "Use an App Token with your username, or an OpenID Connect Bearer Token.",
						visible: () => this.plugin.settings.remoteBackend === "opencloud",
						control: {
							type: "dropdown",
							key: "opencloudAuthType",
							options: {
								"app-token": "Username + App Token",
								bearer: "Bearer Token"
							}
						}
					},
					{
						name: "OpenCloud username",
						desc: "Username or UUID required for App Token authentication.",
						visible: () => this.plugin.settings.remoteBackend === "opencloud"
							&& this.plugin.settings.opencloudAuthType === "app-token",
						control: {
							type: "text",
							key: "opencloudUsername",
							placeholder: "username or UUID"
						}
					},
					{
						name: "OpenCloud token",
						desc: "App Token or Bearer Token. The value is stored in Obsidian plugin data.",
						visible: () => this.plugin.settings.remoteBackend === "opencloud",
						render: (setting) => {
							setting.addText((text) => {
								text.inputEl.type = "password";
								text
									.setPlaceholder("Token")
									.setValue(this.plugin.settings.opencloudToken)
									.onChange(async (value) => {
										this.plugin.settings.opencloudToken = value;
										await this.plugin.saveSettings();
									});
							});
						}
					},
					{
						name: "OpenCloud remote path",
						desc: "Directory inside the selected Space where files will be synchronized.",
						visible: () => this.plugin.settings.remoteBackend === "opencloud",
						control: {
							type: "text",
							key: "opencloudRemotePath",
							placeholder: "/Notes"
						}
					},
					{
						name: "OpenCloud TUS chunk size",
						desc: "Chunk size in MB for resumable uploads (1-10 MB).",
						visible: () => this.plugin.settings.remoteBackend === "opencloud",
						control: {
							type: "text",
							key: "opencloudTusChunkSizeMb",
							placeholder: "5"
						}
					}
				]
			}
		];
	}

	getControlValue(key: string): unknown {
		if (key === "opencloudTusChunkSizeMb") {
			return String(this.plugin.settings.opencloudTusChunkSizeMb);
		}
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
			case "opencloudAuthType": {
				const authType = String(value);
				if (!isOpenCloudAuthType(authType)) {
					return;
				}
				this.plugin.settings.opencloudAuthType = authType;
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
			case "opencloudUrl":
				this.plugin.settings.opencloudUrl = String(value).trim().replace(/\/+$/g, "");
				break;
			case "opencloudSpaceId":
				this.plugin.settings.opencloudSpaceId = normalizeOpenCloudSpaceId(String(value));
				break;
			case "opencloudUsername":
				this.plugin.settings.opencloudUsername = String(value).trim();
				break;
			case "opencloudRemotePath":
				this.plugin.settings.opencloudRemotePath = String(value).trim();
				break;
			case "opencloudTusChunkSizeMb": {
				const chunkSize = Number(value);
				if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 10) {
					return;
				}
				this.plugin.settings.opencloudTusChunkSizeMb = chunkSize;
				break;
			}
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
			| "lastRemotePushAt"
			| "lastRemotePullAt"
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
			"Last push to remote",
			"Last successful remote push execution.",
			this.plugin.settings.lastRemotePushAt
		);
		this.addReadonlyLegacyDateSetting(
			localSectionEl,
			"Last pull from remote",
			"Last successful remote pull execution.",
			this.plugin.settings.lastRemotePullAt
		);

		this.addReadonlyLegacyDateSetting(
			localDataSectionEl,
			"Last local database reset",
			"Last time the local file and conflict databases were reset.",
			this.plugin.settings.lastLocalDatabaseResetAt
		);

		new Setting(localDataSectionEl)
			.setName("Reset local databases")
			.setDesc("Delete the local file index, conflicts, revisions, baselines, and replication checkpoints. Vault files and remote data are not changed.")
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
					.addOption("opencloud", "OpenCloud")
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
		} else if (this.plugin.settings.remoteBackend === "opencloud") {
			new Setting(remoteSectionEl)
				.setName("OpenCloud URL")
				.setDesc("Base URL for the OpenCloud server (e.g., https://cloud.example.com).")
				.addText((text) =>
					text
						.setPlaceholder("https://cloud.example.com")
						.setValue(this.plugin.settings.opencloudUrl)
						.onChange(async (value) => {
							this.plugin.settings.opencloudUrl = value.trim().replace(/\/+$/g, "");
							await this.plugin.saveSettings();
						})
				);

			new Setting(remoteSectionEl)
				.setName("OpenCloud Space ID")
				.setDesc("Resource ID from the Space WebDAV URL.")
				.addText((text) =>
					text
						.setPlaceholder("storage-id$space-id")
						.setValue(this.plugin.settings.opencloudSpaceId)
						.onChange(async (value) => {
							this.plugin.settings.opencloudSpaceId = normalizeOpenCloudSpaceId(value);
							await this.plugin.saveSettings();
						})
				);

			new Setting(remoteSectionEl)
				.setName("OpenCloud authentication")
				.setDesc("Use an App Token with your username, or an OpenID Connect Bearer Token.")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("app-token", "Username + App Token")
						.addOption("bearer", "Bearer Token")
						.setValue(this.plugin.settings.opencloudAuthType)
						.onChange(async (value) => {
							if (!isOpenCloudAuthType(value)) return;
							this.plugin.settings.opencloudAuthType = value;
							await this.plugin.saveSettings();
							this.display();
						})
				);

			if (this.plugin.settings.opencloudAuthType === "app-token") {
				new Setting(remoteSectionEl)
					.setName("OpenCloud username")
					.setDesc("Username or UUID required for App Token authentication.")
					.addText((text) =>
						text
							.setPlaceholder("username or UUID")
							.setValue(this.plugin.settings.opencloudUsername)
							.onChange(async (value) => {
								this.plugin.settings.opencloudUsername = value.trim();
								await this.plugin.saveSettings();
							})
					);
			}

			new Setting(remoteSectionEl)
				.setName("OpenCloud token")
				.setDesc("App Token or Bearer Token. The value is stored in Obsidian plugin data.")
				.addText((text) => {
					text.inputEl.type = "password";
					text
						.setPlaceholder("Token")
						.setValue(this.plugin.settings.opencloudToken)
						.onChange(async (value) => {
							this.plugin.settings.opencloudToken = value;
							await this.plugin.saveSettings();
						});
				});

			new Setting(remoteSectionEl)
				.setName("OpenCloud remote path")
				.setDesc("Directory inside the selected Space where files will be synchronized.")
				.addText((text) =>
					text
						.setPlaceholder("/Notes")
						.setValue(this.plugin.settings.opencloudRemotePath)
						.onChange(async (value) => {
							this.plugin.settings.opencloudRemotePath = value.trim();
							await this.plugin.saveSettings();
						})
				);

			new Setting(remoteSectionEl)
				.setName("OpenCloud TUS chunk size")
				.setDesc("Chunk size in MB for resumable uploads (1-10 MB).")
				.addText((text) =>
					text
						.setPlaceholder("5")
						.setValue(String(this.plugin.settings.opencloudTusChunkSizeMb))
						.onChange(async (value) => {
							const chunkSize = Number(value);
							if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 10) return;
							this.plugin.settings.opencloudTusChunkSizeMb = chunkSize;
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
