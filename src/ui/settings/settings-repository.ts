import type { Plugin } from "obsidian";
import {
	ANDROID_NOMEDIA_PATH,
	DEFAULT_SETTINGS,
	isOpenCloudAuthType,
	isRemoteSyncBackend,
	isSyncFolderMode,
	type MySyncSettings,
	STRING_SETTING_KEYS
} from "../../core";
import { normalizeOpenCloudSpaceId } from "../../backends";
import { isLoggerLevel, Logger } from "../../utils/logger";
import { isAndroidApp } from "../../utils/platform";

const logger = new Logger("SettingsRepository");

export class SettingsRepository {
	constructor(private readonly plugin: Plugin) {}

	async loadSettings(): Promise<MySyncSettings> {
		const savedData = await this.plugin.loadData();
		const savedSettings = normalizeSavedSettings(savedData);
		const settings: MySyncSettings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);

		Logger.setLevel(settings.logLevel);
		let settingsChanged = false;

		if (!settings.localVaultId) {
			settings.localVaultId = createLocalVaultId();
			settingsChanged = true;
		}

		const localDatabaseName = createLocalDatabaseName(settings.localVaultId);
		const expectedConflictDatabase = createConflictDatabaseName(localDatabaseName);

		if (settings.localConflictDatabase !== expectedConflictDatabase) {
			settings.localConflictDatabase = expectedConflictDatabase;
			settingsChanged = true;
		}

		if (settingsChanged) {
			await this.saveSettings(settings);
		}

		return settings;
	}

	async saveSettings(settings: MySyncSettings): Promise<void> {
		await this.plugin.saveData(settings);
	}

	async ensureAndroidNoMediaFile(): Promise<void> {
		if (!isAndroidApp()) {
			return;
		}

		try {
			if (await this.plugin.app.vault.adapter.exists(ANDROID_NOMEDIA_PATH, true)) {
				return;
			}

			await this.plugin.app.vault.adapter.write(ANDROID_NOMEDIA_PATH, "");
		} catch (error) {
			logger.warn("Failed to create Android .nomedia file", error);
		}
	}
}

export function createLocalVaultId(): string {
	if (typeof crypto.randomUUID === "function") {
		const [shortId] = crypto.randomUUID().split("-");
		if (shortId) {
			return shortId;
		}
	}

	const randomPart = typeof crypto.getRandomValues === "function"
		? Array.from(
			crypto.getRandomValues(new Uint8Array(4)),
			(byte) => byte.toString(16).padStart(2, "0")
		).join("")
		: Math.random().toString(36).slice(2, 10);

	return `${Date.now().toString(36)}-${randomPart}`;
}

export function createLocalDatabaseName(localVaultId: string): string {
	return `mysync-files-${localVaultId}`;
}

export function createConflictDatabaseName(localDatabaseName: string): string {
	const localDatabasePrefix = "mysync-files-";

	if (localDatabaseName.startsWith(localDatabasePrefix)) {
		return `mysync-conflicts-${localDatabaseName.slice(localDatabasePrefix.length)}`;
	}

	return `${localDatabaseName}-conflicts`;
}

export function normalizeSavedSettings(data: unknown): Partial<MySyncSettings> {
	if (!isRecord(data)) {
		return {};
	}

	const settings: Partial<MySyncSettings> = {};

	for (const key of STRING_SETTING_KEYS) {
		const value = data[key];
		if (typeof value === "string") {
			settings[key] = value;
		}
	}

	if (typeof data.opencloudSpaceId === "string") {
		settings.opencloudSpaceId = normalizeOpenCloudSpaceId(data.opencloudSpaceId);
	}

	if (typeof data["lastPushToCouchDbAt"] === "string" && !settings.lastRemotePushAt) {
		settings.lastRemotePushAt = data["lastPushToCouchDbAt"] as string;
	}

	if (typeof data["lastPullFromCouchDbAt"] === "string" && !settings.lastRemotePullAt) {
		settings.lastRemotePullAt = data["lastPullFromCouchDbAt"] as string;
	}

	if (isSyncFolderMode(data.syncFolderMode)) {
		settings.syncFolderMode = data.syncFolderMode;
	}

	if (typeof data.remoteBackend === "string" && isRemoteSyncBackend(data.remoteBackend)) {
		settings.remoteBackend = data.remoteBackend;
	}

	if (typeof data.opencloudAuthType === "string" && isOpenCloudAuthType(data.opencloudAuthType)) {
		settings.opencloudAuthType = data.opencloudAuthType;
	}

	if (
		typeof data.opencloudTusChunkSizeMb === "number"
		&& Number.isInteger(data.opencloudTusChunkSizeMb)
		&& data.opencloudTusChunkSizeMb >= 1
		&& data.opencloudTusChunkSizeMb <= 10
	) {
		settings.opencloudTusChunkSizeMb = data.opencloudTusChunkSizeMb;
	}

	if (typeof data.syncObsidianConfig === "boolean") {
		settings.syncObsidianConfig = data.syncObsidianConfig;
	}

	if (isLoggerLevel(data.logLevel)) {
		settings.logLevel = data.logLevel;
	}

	return settings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

