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
}

export interface VaultFileAttachment {
	content_type: string;
	data: Blob;
}
