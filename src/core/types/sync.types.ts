export interface LocalSyncResult {
	total: number;
	saved: number;
	skipped: number;
}

export interface RestoreResult {
	total: number;
	restored: number;
	skipped: number;
	conflicts: number;
	configurationChanged: boolean;
}

export interface RemoteDeletionResult {
	total: number;
	deleted: number;
	skipped: number;
	conflicts: number;
	configurationChanged: boolean;
}

export interface PullClassification {
	deletedRecordIds: string[];
	conflictedRecordIds: Set<string>;
}

export interface EmptyFolderCleanupResult {
	total: number;
	removed: number;
	skipped: number;
}

export type SyncStatus =
	| { state: "idle" }
	| { state: "queued"; pending: number }
	| { state: "syncing"; current: number; total: number; saved: number; skipped: number }
	| { state: "done"; total: number; saved: number; skipped: number }
	| { state: "pushing"; docsWritten: number; totalDocs?: number }
	| { state: "pushed"; docsWritten: number }
	| { state: "pulling"; docsRead: number }
	| { state: "deleting"; current: number; total: number; deleted: number; skipped: number; conflicts: number }
	| { state: "restoring"; current: number; total: number; restored: number; skipped: number; conflicts: number }
	| { state: "pulled"; docsRead: number; restored: number; deleted: number; skipped: number; conflicts: number }
	| { state: "cleaning-empty-folders"; current: number; total: number; removed: number; skipped: number }
	| { state: "empty-folders-cleaned"; removed: number; skipped: number }
	| { state: "resetting-local-databases" }
	| { state: "local-databases-reset" }
	| { state: "testing" }
	| { state: "tested"; databaseName: string; documentCount?: number }
	| { state: "error"; message: string };

export type CompletedSyncOperation =
	| "syncNow"
	| "remotePush"
	| "remotePull"
	| "resetLocalDatabases";

export interface NextcloudDeletionConfirmation {
	backendName: "Nextcloud" | "OpenCloud";
	target: string;
	count: number;
	percentage: number;
}

