export type VaultFileType = "markdown" | "image" | "binary" | "other";

export interface VaultFileRecord {
	_id: string;
	type: "vault-file";
	source?: "vault" | "obsidian-config";
	fileType: VaultFileType;
	fileName: string;
	path: string;
	mimeType?: string;
	size: number;
	contentHash: string;
	content?: string;
	_attachments?: Record<string, VaultFileAttachment>;
	lastChanged: number;
	lastChangedIso: string;
	conflictResolution?: ConflictResolutionMarker;
}

export interface VaultFileAttachment {
	content_type: string;
	data: Blob;
}

export interface ConflictResolutionMarker {
	acknowledgedDeletedLeafRevisions: string[];
	resolvedAt: string;
	resolvedBy: string;
	strategy: ConflictResolutionStrategy;
}

export type SyncConflictKind =
	| "edit-edit"
	| "local-edit-remote-delete"
	| "local-delete-remote-edit"
	| "path-collision";

export type SyncConflictStatus =
	| "pending"
	| "resolving"
	| "pending-push"
	| "resolved"
	| "stale"
	| "error";

export type ConflictResolutionStrategy =
	| "keep-local"
	| "keep-remote"
	| "keep-both"
	| "delete";

export interface SyncConflictLocalVariant {
	exists: boolean;
	contentHash?: string;
	fileType?: VaultFileType;
	lastChanged?: number;
}

export interface SyncConflictRemoteVariant {
	revision: string;
	deleted: boolean;
	winning: boolean;
	contentHash?: string;
	fileType?: VaultFileType;
	lastChangedIso?: string;
}

interface SyncConflictBase {
	_id: string;
	_rev?: string;
	recordId: string;
	path: string;
	kind: SyncConflictKind;
	status: SyncConflictStatus;
	detectedAt: string;
	updatedAt: string;
	localVariant: SyncConflictLocalVariant;
	error?: string;
}

export interface CouchDbSyncConflict extends SyncConflictBase {
	/** Missing on documents created before backend discrimination was introduced. */
	backend?: "couchdb";
	observedLeafRevisions: string[];
	remoteVariants: SyncConflictRemoteVariant[];
	resolution?: {
		strategy: ConflictResolutionStrategy;
		selectedRevision?: string;
		resolvedDocumentIds: string[];
		resolvedAt: string;
	};
}

export interface NextcloudRemoteFileMetadata {
	path: string;
	etag: string;
	lastModified?: string;
	size: number;
	contentType?: string;
}

export interface NextcloudSyncStateEntry extends NextcloudRemoteFileMetadata {
	syncedContentHash: string;
}

export interface NextcloudSyncState {
	type: "mysync-nextcloud-sync-state";
	targetKey: string;
	initializedAt: string;
	lastCompletedAt?: string;
	entries: Record<string, NextcloudSyncStateEntry>;
}

export interface NextcloudPendingOperation {
	action: "upload" | "delete";
	path: string;
	ifMatch?: string;
	ifNoneMatch?: "*";
	expectedContentHash?: string;
}

export interface NextcloudSyncConflict extends SyncConflictBase {
	backend: "nextcloud";
	targetKey: string;
	observedLocalContentHash?: string;
	remote: {
		exists: boolean;
		etag?: string;
		lastModified?: string;
		size?: number;
		contentType?: string;
		contentHash?: string;
	};
	pendingOperation?: NextcloudPendingOperation;
	resolution?: {
		strategy: ConflictResolutionStrategy;
		resolvedDocumentIds: string[];
		resolvedAt: string;
		copyPath?: string;
	};
}

export type SyncConflict = CouchDbSyncConflict | NextcloudSyncConflict;
