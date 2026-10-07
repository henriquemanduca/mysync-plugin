import type { ConflictResolutionMarker, VaultFileType } from "./conflict.types";

export interface VaultFileAttachment {
	content_type: string;
	data: Blob;
}

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

