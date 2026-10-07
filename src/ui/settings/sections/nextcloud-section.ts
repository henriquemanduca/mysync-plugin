import { Setting } from "obsidian";
import type MySyncPlugin from "../../../main";

export function renderNextcloudSection(containerEl: HTMLElement, plugin: MySyncPlugin): void {
	new Setting(containerEl)
		.setName("Nextcloud URL")
		.setDesc("Base URL for the Nextcloud server (e.g., https://cloud.example.com).")
		.addText((text) =>
			text
				.setPlaceholder("https://cloud.example.com")
				.setValue(plugin.settings.nextcloudUrl)
				.onChange(async (value) => {
					plugin.settings.nextcloudUrl = value.trim().replace(/\/+$/g, "");
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Nextcloud username")
		.setDesc("Username for Nextcloud login.")
		.addText((text) =>
			text
				.setPlaceholder("username")
				.setValue(plugin.settings.nextcloudUsername)
				.onChange(async (value) => {
					plugin.settings.nextcloudUsername = value.trim();
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Nextcloud App Password")
		.setDesc("Use an App Password generated in your Nextcloud security settings, NOT your main password.")
		.addText((text) => {
			text.inputEl.type = "password";
			text
				.setPlaceholder("App Password")
				.setValue(plugin.settings.nextcloudPassword)
				.onChange(async (value) => {
					plugin.settings.nextcloudPassword = value;
					await plugin.saveSettings();
				});
		});

	new Setting(containerEl)
		.setName("Nextcloud Remote Path")
		.setDesc("Directory in Nextcloud where files will be synced (e.g., /Notes).")
		.addText((text) =>
			text
				.setPlaceholder("/Notes")
				.setValue(plugin.settings.nextcloudRemotePath)
				.onChange(async (value) => {
					plugin.settings.nextcloudRemotePath = value.trim();
					await plugin.saveSettings();
				})
		);
}
