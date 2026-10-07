import { Setting } from "obsidian";
import type { App } from "obsidian";
import type MySyncPlugin from "../../../main";
import { isSyncFolderMode } from "../../../core";
import { formatDateTime } from "../../../utils/date-format";

export function renderLocalConfigSection(
	containerEl: HTMLElement,
	app: App,
	plugin: MySyncPlugin,
	onRefresh: () => void
): void {
	new Setting(containerEl)
		.setName("Local file database")
		.setDesc("Automatically created database for files in this vault.")
		.addText((text) => {
			text.inputEl.readOnly = true;
			text.inputEl.addClass("mysync-readonly-setting");
			text.setValue(`mysync-files-${plugin.settings.localVaultId}`);
		});

	new Setting(containerEl)
		.setName("Local conflict database")
		.setDesc("Automatically created database for unresolved conflicts.")
		.addText((text) => {
			text.inputEl.readOnly = true;
			text.inputEl.addClass("mysync-readonly-setting");
			text.setValue(plugin.settings.localConflictDatabase);
		});

	new Setting(containerEl)
		.setName("Folder source")
		.setDesc(`Choose what folder to sync. Current vault: ${app.vault.getName()}.`)
		.addDropdown((dropdown) =>
			dropdown
				.addOption("vault-root", "Use Obsidian vault root")
				.addOption("custom", "Set a custom folder")
				.setValue(plugin.settings.syncFolderMode)
				.onChange(async (value) => {
					if (!isSyncFolderMode(value)) {
						return;
					}

					plugin.settings.syncFolderMode = value;
					await plugin.saveSettings();
					onRefresh();
				})
		);

	new Setting(containerEl)
		.setName("Custom sync folder")
		.setDesc("Folder path inside the vault to sync when custom folder mode is selected.")
		.addText((text) =>
			text
				.setPlaceholder("Projects/MySync")
				.setValue(plugin.settings.customSyncFolder)
				.setDisabled(plugin.settings.syncFolderMode !== "custom")
				.onChange(async (value) => {
					plugin.settings.customSyncFolder = value.trim();
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Sync Obsidian configuration")
		.setDesc("Synchronize top-level Obsidian configuration files (app.json, hotkeys.json, workspace.json).")
		.addToggle((toggle) =>
			toggle
				.setValue(plugin.settings.syncObsidianConfig)
				.onChange(async (value) => {
					plugin.settings.syncObsidianConfig = value;
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Obsidian configuration folder")
		.setDesc("Top-level files in this folder are included in synchronization when enabled.")
		.addText((text) => {
			text.inputEl.readOnly = true;
			text.inputEl.addClass("mysync-readonly-setting");
			text.setValue(app.vault.configDir);
		});

	new Setting(containerEl)
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
				.setValue(plugin.settings.logLevel)
				.onChange(async (value) => {
					plugin.updateLogLevel(value);
					await plugin.saveSettings();
				})
		);

	addReadonlyDateSetting(
		containerEl,
		"Last sync now",
		"Last successful local sync execution.",
		plugin.settings.lastSyncNowAt
	);
	addReadonlyDateSetting(
		containerEl,
		"Last push to remote",
		"Last successful remote push execution.",
		plugin.settings.lastRemotePushAt
	);
	addReadonlyDateSetting(
		containerEl,
		"Last pull from remote",
		"Last successful remote pull execution.",
		plugin.settings.lastRemotePullAt
	);
}

export function addReadonlyDateSetting(
	containerEl: HTMLElement,
	name: string,
	desc: string,
	dateIsoString: string
): void {
	new Setting(containerEl)
		.setName(name)
		.setDesc(desc)
		.addText((text) => {
			text.inputEl.readOnly = true;
			text.inputEl.addClass("mysync-readonly-setting");
			text.setValue(formatDateTime(dateIsoString, {
				fallback: "Never",
				invalidFallback: dateIsoString
			}));
		});
}
