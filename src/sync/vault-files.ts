import { App, TFile, TFolder } from "obsidian";
import type { VaultFileRecord, VaultFileType } from "sync/types";

const VAULT_FILE_PREFIX = "vault-file";
const FILE_ATTACHMENT_ID = "file";
const IMAGE_MIME_TYPES: Record<string, string> = {
	avif: "image/avif",
	bmp: "image/bmp",
	gif: "image/gif",
	heic: "image/heic",
	heif: "image/heif",
	ico: "image/x-icon",
	jfif: "image/jpeg",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	svg: "image/svg+xml",
	tif: "image/tiff",
	tiff: "image/tiff",
	webp: "image/webp"
};
const BINARY_MIME_TYPES: Record<string, string> = {
	pdf: "application/pdf"
};

export function getSyncFolder(
	app: App,
	syncFolderMode: "vault-root" | "custom",
	customSyncFolder: string
) {
	if (syncFolderMode === "custom") {
		return customSyncFolder.trim();
	}

	return app.vault.getRoot().path || "/";
}

export function getSyncFolderState(
	app: App,
	syncFolder: string
): { valid: true; folder: TFolder } | { valid: false; message: string } {
	const normalizedFolder = normalizeVaultFolder(syncFolder);

	if (normalizedFolder === "/") {
		return {
			valid: true,
			folder: app.vault.getRoot()
		};
	}

	const abstractFile = app.vault.getAbstractFileByPath(normalizedFolder);

	if (!abstractFile) {
		return {
			valid: false,
			message: `Folder not found: ${normalizedFolder}`
		};
	}

	if (!(abstractFile instanceof TFolder)) {
		return {
			valid: false,
			message: `Path is not a folder: ${normalizedFolder}`
		};
	}

	return {
		valid: true,
		folder: abstractFile
	};
}

export function collectFilesInFolder(folder: TFolder) {
	const files: TFile[] = [];
	const remainingFolders = [folder];

	while (remainingFolders.length > 0) {
		const currentFolder = remainingFolders.pop();

		if (!currentFolder) {
			continue;
		}

		for (const child of currentFolder.children) {
			if (child instanceof TFile) {
				files.push(child);
			} else if (child instanceof TFolder) {
				remainingFolders.push(child);
			}
		}
	}

	return files;
}

export function isFileInsideSyncFolder(file: TFile, syncFolder: string) {
	return isPathInsideSyncFolder(file.path, syncFolder);
}

export function isPathInsideSyncFolder(path: string, syncFolder: string) {
	const normalizedFolder = normalizeVaultFolder(syncFolder);

	if (normalizedFolder === "/") {
		return true;
	}

	return path === normalizedFolder || path.startsWith(`${normalizedFolder}/`);
}

export async function createFileRecord(app: App, file: TFile): Promise<VaultFileRecord> {
	const extension = file.extension.toLowerCase();
	const imageMimeType = getImageMimeType(extension);
	const mimeType = imageMimeType ?? getBinaryMimeType(extension);
	const fileType = getVaultFileType(extension, imageMimeType, mimeType);
	const record: VaultFileRecord = {
		_id: createFileRecordId(file.path),
		type: "vault-file",
		fileType,
		fileName: file.name,
		path: file.path,
		size: file.stat.size,
		lastChanged: file.stat.mtime,
		lastChangedIso: new Date(file.stat.mtime).toISOString()
	};

	if (mimeType) {
		record.mimeType = mimeType;
	}

	if (fileType === "markdown") {
		record.content = await app.vault.cachedRead(file);

	} else if (mimeType) {
		const data = await app.vault.readBinary(file);
		record._attachments = {
			[FILE_ATTACHMENT_ID]: {
				content_type: mimeType,
				data: new Blob([data], { type: mimeType })
			}
		};
	}

	return record;
}

export function createFileRecordId(path: string) {
	return `${VAULT_FILE_PREFIX}:${path}`;
}

export function getPathFromFileRecordId(id: string) {
	const prefix = `${VAULT_FILE_PREFIX}:`;

	if (!id.startsWith(prefix)) {
		return null;
	}

	return id.slice(prefix.length);
}

function normalizeVaultFolder(folder: string) {
	const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
	return trimmed || "/";
}

function getVaultFileType(
	extension: string,
	imageMimeType: string | undefined,
	mimeType: string | undefined
): VaultFileType {
	if (extension === "md") {
		return "markdown";
	}

	if (imageMimeType) {
		return "image";
	}

	if (mimeType) {
		return "binary";
	}

	return "other";
}

function getImageMimeType(extension: string) {
	return IMAGE_MIME_TYPES[extension];
}

function getBinaryMimeType(extension: string) {
	return BINARY_MIME_TYPES[extension];
}
