import { App, PluginSettingTab, Setting } from "obsidian";
import type MySyncPlugin from "main";

export type SyncFolderMode = "vault-root" | "custom";

export interface MySyncSettings {
	localVaultId: string;
	syncFolderMode: SyncFolderMode;
	customSyncFolder: string;
	couchDbUrl: string;
	couchDbDatabase: string;
	couchDbUsername: string;
	couchDbPassword: string;
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
	syncOnStartup: false,
	lastSyncNowAt: "",
	lastPushToCouchDbAt: "",
	lastPullFromCouchDbAt: ""
};

function isSyncFolderMode(value: string): value is SyncFolderMode {
	return value === "vault-root" || value === "custom";
}

function formatLastExecutionAt(value: string): string {
	if (!value) {
		return "Never";
	}

	const date = new Date(value);

	if (Number.isNaN(date.getTime())) {
		return value;
	}

	const day = String(date.getDate()).padStart(2, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const year = date.getFullYear();
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");

	return `${day}/${month}/${year} ${hour}:${minute}`;
}

export class MySyncSettingTab extends PluginSettingTab {
	plugin: MySyncPlugin;

	constructor(app: App, plugin: MySyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private createSection(name: string): HTMLElement {
		const sectionEl = this.containerEl.createDiv({ cls: "mysync-settings-section" });
		sectionEl.createEl("h3", { text: name, cls: "mysync-settings-heading" });
		return sectionEl;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const localSectionEl = this.createSection("Local configuration");
		const remoteSectionEl = this.createSection("Remote database");

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
						this.display();
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
			.setName("Last sync now")
			.setDesc("Last successful local sync execution.")
			.addText((text) => {
				text.inputEl.readOnly = true;
				text.inputEl.addClass("mysync-readonly-setting");
				text.setValue(formatLastExecutionAt(this.plugin.settings.lastSyncNowAt));
			});

		new Setting(localSectionEl)
			.setName("Last push to CouchDB")
			.setDesc("Last successful remote push execution.")
			.addText((text) => {
				text.inputEl.readOnly = true;
				text.inputEl.addClass("mysync-readonly-setting");
				text.setValue(formatLastExecutionAt(this.plugin.settings.lastPushToCouchDbAt));
			});

		new Setting(localSectionEl)
			.setName("Last pull from CouchDB")
			.setDesc("Last successful remote pull execution.")
			.addText((text) => {
				text.inputEl.readOnly = true;
				text.inputEl.addClass("mysync-readonly-setting");
				text.setValue(formatLastExecutionAt(this.plugin.settings.lastPullFromCouchDbAt));
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
}
