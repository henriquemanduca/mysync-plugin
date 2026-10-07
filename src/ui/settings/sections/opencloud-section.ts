import { Setting } from "obsidian";
import type MySyncPlugin from "../../../main";
import { isOpenCloudAuthType } from "../../../core/types/settings.types";
import { normalizeOpenCloudSpaceId } from "../../../sync/opencloud-path";

export function renderOpenCloudSection(
	containerEl: HTMLElement,
	plugin: MySyncPlugin,
	onRefresh: () => void
): void {
	new Setting(containerEl)
		.setName("OpenCloud URL")
		.setDesc("Base URL for the OpenCloud server (e.g., https://cloud.example.com).")
		.addText((text) =>
			text
				.setPlaceholder("https://cloud.example.com")
				.setValue(plugin.settings.opencloudUrl)
				.onChange(async (value) => {
					plugin.settings.opencloudUrl = value.trim().replace(/\/+$/g, "");
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("OpenCloud Space ID")
		.setDesc("Resource ID from the Space WebDAV URL.")
		.addText((text) =>
			text
				.setPlaceholder("storage-id$space-id")
				.setValue(plugin.settings.opencloudSpaceId)
				.onChange(async (value) => {
					plugin.settings.opencloudSpaceId = normalizeOpenCloudSpaceId(value);
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("OpenCloud authentication")
		.setDesc("Use an App Token with your username, or an OpenID Connect Bearer Token.")
		.addDropdown((dropdown) =>
			dropdown
				.addOption("app-token", "Username + App Token")
				.addOption("bearer", "Bearer Token")
				.setValue(plugin.settings.opencloudAuthType)
				.onChange(async (value) => {
					if (!isOpenCloudAuthType(value)) {
						return;
					}

					plugin.settings.opencloudAuthType = value;
					await plugin.saveSettings();
					onRefresh();
				})
		);

	if (plugin.settings.opencloudAuthType === "app-token") {
		new Setting(containerEl)
			.setName("OpenCloud username")
			.setDesc("Username or UUID required for App Token authentication.")
			.addText((text) =>
				text
					.setPlaceholder("username or UUID")
					.setValue(plugin.settings.opencloudUsername)
					.onChange(async (value) => {
						plugin.settings.opencloudUsername = value.trim();
						await plugin.saveSettings();
					})
			);
	}

	new Setting(containerEl)
		.setName("OpenCloud token")
		.setDesc("App Token or Bearer Token. The value is stored in Obsidian plugin data.")
		.addText((text) => {
			text.inputEl.type = "password";
			text
				.setPlaceholder("Token")
				.setValue(plugin.settings.opencloudToken)
				.onChange(async (value) => {
					plugin.settings.opencloudToken = value;
					await plugin.saveSettings();
				});
		});

	new Setting(containerEl)
		.setName("OpenCloud remote path")
		.setDesc("Directory inside the selected Space where files will be synchronized.")
		.addText((text) =>
			text
				.setPlaceholder("/Notes")
				.setValue(plugin.settings.opencloudRemotePath)
				.onChange(async (value) => {
					plugin.settings.opencloudRemotePath = value.trim();
					await plugin.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("OpenCloud TUS chunk size")
		.setDesc("Chunk size in MB for resumable uploads (1-10 MB).")
		.addText((text) =>
			text
				.setPlaceholder("5")
				.setValue(String(plugin.settings.opencloudTusChunkSizeMb))
				.onChange(async (value) => {
					const chunkSize = Number(value);
					if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 10) {
						return;
					}

					plugin.settings.opencloudTusChunkSizeMb = chunkSize;
					await plugin.saveSettings();
				})
		);
}
