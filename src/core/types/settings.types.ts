import type { LoggerLevel } from "../../utils/logger";

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

export function isSyncFolderMode(value: unknown): value is SyncFolderMode {
	return value === "vault-root" || value === "custom";
}

export function isRemoteSyncBackend(value: unknown): value is RemoteSyncBackend {
	return value === "couchdb" || value === "nextcloud" || value === "opencloud";
}

export function isOpenCloudAuthType(value: unknown): value is OpenCloudAuthType {
	return value === "app-token" || value === "bearer";
}

