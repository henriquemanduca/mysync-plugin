import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type MySyncPlugin from "../../main";
import {
	type MySyncSettings,
	isOpenCloudAuthType,
	isRemoteSyncBackend,
	isSyncFolderMode
} from "../../core";
import { normalizeOpenCloudSpaceId } from "../../backends";
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
		const { containerEl } = this;
		containerEl.empty();

		const localSectionEl = this.createSection("Local configuration");
		renderLocalConfigSection(localSectionEl, this.app, this.plugin, () => this.display());

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
						this.display();
					})
			);

		if (this.plugin.settings.remoteBackend === "couchdb") {
			renderCouchDbSection(remoteSectionEl, this.plugin);
		} else if (this.plugin.settings.remoteBackend === "nextcloud") {
			renderNextcloudSection(remoteSectionEl, this.plugin);
		} else if (this.plugin.settings.remoteBackend === "opencloud") {
			renderOpenCloudSection(remoteSectionEl, this.plugin, () => this.display());
		}
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		// Retained for forward compatibility with programmatic Obsidian settings forms
		return [];
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

	private createSection(name: string): HTMLElement {
		const sectionEl = this.containerEl.createDiv({ cls: "mysync-settings-section" });
		new Setting(sectionEl).setName(name).setHeading();
		return sectionEl;
	}
}

