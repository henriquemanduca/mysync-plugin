import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";
import type MySyncPlugin from "../../main";
import {
	type MySyncSettings,
	isOpenCloudAuthType,
	isRemoteSyncBackend,
	isSyncFolderMode
} from "../../core";
import { normalizeOpenCloudSpaceId } from "../../backends";
import { setDestructiveButton } from "../../utils/button";
import { formatDateTime } from "../../utils/date-format";
import { renderLocalConfigSection } from "./sections/local-config-section";
import { renderLocalDataSection } from "./sections/local-data-section";
import { renderCouchDbSection } from "./sections/couchdb-section";
import { renderNextcloudSection } from "./sections/nextcloud-section";
import { renderOpenCloudSection } from "./sections/opencloud-section";

function refreshDomStateIfAvailable(settingTab: PluginSettingTab): void {
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
		key: "lastSyncNowAt" | "lastRemotePushAt" | "lastRemotePullAt" | "lastLocalDatabaseResetAt"
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

	private renderLegacySettings(): void {
		const { containerEl } = this;
		containerEl.empty();

		const localSectionEl = this.createSection("Local configuration");
		renderLocalConfigSection(localSectionEl, this.app, this.plugin, () => this.renderLegacySettings());

		const localDataSectionEl = this.createSection("Local data");
		renderLocalDataSection(localDataSectionEl, this.plugin);

		const remoteSectionEl = this.createSection("Remote database");
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
			renderCouchDbSection(remoteSectionEl, this.plugin);
		} else if (this.plugin.settings.remoteBackend === "nextcloud") {
			renderNextcloudSection(remoteSectionEl, this.plugin);
		} else if (this.plugin.settings.remoteBackend === "opencloud") {
			renderOpenCloudSection(remoteSectionEl, this.plugin, () => this.renderLegacySettings());
		}
	}

	private createSection(name: string): HTMLElement {
		const sectionEl = this.containerEl.createDiv({ cls: "mysync-settings-section" });
		new Setting(sectionEl).setName(name).setHeading();
		return sectionEl;
	}
}
