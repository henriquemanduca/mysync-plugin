import type { MySyncSettings } from "../types/settings.types";

export const DEFAULT_SETTINGS: MySyncSettings = {
	localVaultId: "",
	localConflictDatabase: "",
	syncFolderMode: "vault-root",
	customSyncFolder: "",
	syncObsidianConfig: true,
	remoteBackend: "couchdb",
	couchDbUrl: "",
	couchDbDatabase: "mysync",
	couchDbUsername: "",
	couchDbPassword: "",
	nextcloudUrl: "",
	nextcloudUsername: "",
	nextcloudPassword: "",
	nextcloudRemotePath: "/",
	opencloudUrl: "",
	opencloudSpaceId: "",
	opencloudAuthType: "app-token",
	opencloudUsername: "",
	opencloudToken: "",
	opencloudRemotePath: "/",
	opencloudTusChunkSizeMb: 5,
	logLevel: "debug",
	lastSyncNowAt: "",
	lastRemotePushAt: "",
	lastRemotePullAt: "",
	lastLocalDatabaseResetAt: ""
};

export const STRING_SETTING_KEYS = [
	"localVaultId",
	"localConflictDatabase",
	"customSyncFolder",
	"couchDbUrl",
	"couchDbDatabase",
	"couchDbUsername",
	"couchDbPassword",
	"nextcloudUrl",
	"nextcloudUsername",
	"nextcloudPassword",
	"nextcloudRemotePath",
	"opencloudUrl",
	"opencloudSpaceId",
	"opencloudUsername",
	"opencloudToken",
	"opencloudRemotePath",
	"lastSyncNowAt",
	"lastRemotePushAt",
	"lastRemotePullAt",
	"lastLocalDatabaseResetAt"
] as const;

export const IDLE_STATUS_DELAY_MS = 5000;
export const ANDROID_NOMEDIA_PATH = ".nomedia";

