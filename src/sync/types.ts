export type VaultFileType = "markdown" | "image" | "binary" | "other";

export interface VaultFileRecord {
	_id: string;
	type: "vault-file";
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

export interface SyncConflict {
	_id: string;
	_rev?: string;
	recordId: string;
	path: string;
	kind: SyncConflictKind;
	status: SyncConflictStatus;
	detectedAt: string;
	updatedAt: string;
	observedLeafRevisions: string[];
	localVariant: SyncConflictLocalVariant;
	remoteVariants: SyncConflictRemoteVariant[];
	resolution?: {
		strategy: ConflictResolutionStrategy;
		selectedRevision?: string;
		resolvedDocumentIds: string[];
		resolvedAt: string;
	};
	error?: string;
}
