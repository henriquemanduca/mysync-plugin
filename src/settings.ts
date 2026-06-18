import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";
import type MySyncPlugin from "main";
import { formatDateTime } from "utils/date-format";
import type { LoggerLevel } from "utils/logger";

export type SyncFolderMode = "vault-root" | "custom";

export interface MySyncSettings {
	localVaultId: string;
	syncFolderMode: SyncFolderMode;
	customSyncFolder: string;
	couchDbUrl: string;
	couchDbDatabase: string;
	couchDbUsername: string;
	couchDbPassword: string;
	logLevel: LoggerLevel;
	syncOnStartup: boolean;
	lastSyncNowAt: string;
	lastPushToCouchDbAt: string;
	lastPullFromCouchDbAt: string;
}

export const DEFAULT_SETTINGS: MySyncSettings = {
	localVaultId: "",
	syncFolderMode: "vault-root",
	customSyncFolder: "",
	couchDbUrl: "",
	couchDbDatabase: "mysync",
	couchDbUsername: "",
	couchDbPassword: "",
	logLevel: "debug",
	syncOnStartup: false,
	lastSyncNowAt: "",
	lastPushToCouchDbAt: "",
	lastPullFromCouchDbAt: ""
};

function isSyncFolderMode(value: string): value is SyncFolderMode {
	return value === "vault-root" || value === "custom";
}

function supportsDeclarativeSettings() {
	return typeof (PluginSettingTab.prototype as { getSettingDefinitions?: unknown }).getSettingDefinitions === "function";
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

		if (!supportsDeclarativeSettings()) {
			(this as unknown as { display: () => void }).display = () => this.renderLegacySettings();
		}
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Local configuration",
				cls: "mysync-settings-section",
				items: [
					{
						name: "Local vault ID",
						desc: "Automatically generated identifier for this vault.",
						render: (setting) => {
							setting.addText((text) => {
								text.inputEl.readOnly = true;
								text.inputEl.addClass("mysync-readonly-setting");
								text.setValue(`mysync-files-${this.plugin.settings.localVaultId}`);
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
						name: "Sync on startup",
						desc: "Run a sync when Obsidian loads the plugin.",
						control: {
							type: "toggle",
							key: "syncOnStartup"
						}
					},
					{
						name: "Log level",
						desc: "Minimum level written to the console and mysync.log.",
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
					),
					{
						name: "Reset local database",
						desc: "Create a new local PouchDB database, pull from CouchDB, then delete the previous local database.",
						action: () => {
							void this.plugin.resetLocalDatabase();
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
			case "customSyncFolder":
				this.plugin.settings.customSyncFolder = String(value).trim();
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
			case "syncOnStartup":
				this.plugin.settings.syncOnStartup = Boolean(value);
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
		key: "lastSyncNowAt" | "lastPushToCouchDbAt" | "lastPullFromCouchDbAt"
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
		const remoteSectionEl = this.createLegacySection("Remote database");

		new Setting(localSectionEl)
			.setName("Local vault ID")
			.setDesc("Automatically generated identifier for this vault.")
			.addText((text) => {
				text.inputEl.readOnly = true;
				text.inputEl.addClass("mysync-readonly-setting");
				text.setValue(`mysync-files-${this.plugin.settings.localVaultId}`);
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
			.setName("Sync on startup")
			.setDesc("Run a sync when Obsidian loads the plugin.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(localSectionEl)
			.setName("Log level")
			.setDesc("Minimum level written to the console and mysync.log.")
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

		new Setting(localSectionEl)
			.setName("Reset local database")
			.setDesc("Create a new local PouchDB database, pull from CouchDB, then delete the previous local database.")
			.addButton((button) => {
				button
					.setButtonText("Reset")
					.onClick(() => {
						void this.plugin.resetLocalDatabase();
					});
			});

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
