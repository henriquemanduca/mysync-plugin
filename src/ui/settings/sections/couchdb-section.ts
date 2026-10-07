import { Setting } from "obsidian";
import type MySyncPlugin from "../../../main";

export function renderCouchDbSection(containerEl: HTMLElement, plugin: MySyncPlugin): void {
	new Setting(containerEl)
		.setName("CouchDB URL")
		.setDesc("Base URL for the CouchDB server.")
		.addText((text) =>
			text
				.setPlaceholder("https://couchdb.example.com")
				.setValue(plugin.settings.couchDbUrl)
				.onChange(async (value) => {
					plugin.settings.couchDbUrl = value.trim().replace(/\/+$/g, "");
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("CouchDB database")
		.setDesc("Database name used for remote sync.")
		.addText((text) =>
			text
				.setPlaceholder("mysync")
				.setValue(plugin.settings.couchDbDatabase)
				.onChange(async (value) => {
					plugin.settings.couchDbDatabase = value.trim();
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("CouchDB username")
		.setDesc("Username for CouchDB basic authentication.")
		.addText((text) =>
			text
				.setPlaceholder("username")
				.setValue(plugin.settings.couchDbUsername)
				.onChange(async (value) => {
					plugin.settings.couchDbUsername = value.trim();
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("CouchDB password")
		.setDesc("Password for CouchDB basic authentication.")
		.addText((text) => {
			text.inputEl.type = "password";
			text
				.setPlaceholder("Password")
				.setValue(plugin.settings.couchDbPassword)
				.onChange(async (value) => {
					plugin.settings.couchDbPassword = value;
					await plugin.saveSettings();
				});
		});
}
