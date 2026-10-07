import type { RemoteSyncBackend } from "../types/settings.types";

export interface ConnectionTestResult {
	success: boolean;
	databaseName?: string;
	documentCount?: number;
	message?: string;
}

export interface ISyncBackend {
	readonly backendType: RemoteSyncBackend;
	testConnection(): Promise<ConnectionTestResult>;
	close?(): Promise<void> | void;
}

