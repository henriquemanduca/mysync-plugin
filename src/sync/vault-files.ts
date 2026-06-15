import { App, TFile, TFolder } from "obsidian";
import type { VaultFileRecord, VaultFileType } from "sync/types";

const VAULT_FILE_PREFIX = "vault-file";
const FILE_ATTACHMENT_ID = "file";
const BLACKLISTED_SYNC_FILE_NAMES = new Set([
	".nomedia"
]);
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

export function collectSyncableFilesInFolder(folder: TFolder) {
	return collectFilesInFolder(folder).filter(isSyncableVaultFile);
}

export function isFileInsideSyncFolder(file: TFile, syncFolder: string) {
	return isPathInsideSyncFolder(file.path, syncFolder);
}

export function isSyncableVaultFile(file: TFile) {
	return !isSyncBlacklistedPath(file.path);
}

export function isSyncBlacklistedPath(path: string) {
	const fileName = path.split("/").pop();
	return typeof fileName === "string" && BLACKLISTED_SYNC_FILE_NAMES.has(fileName);
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
	const fileContent = await readVaultFileContent(app, file, fileType);
	const record: VaultFileRecord = {
		_id: createFileRecordId(file.path),
		type: "vault-file",
		fileType,
		fileName: file.name,
		path: file.path,
		size: file.stat.size,
		contentHash: fileContent.contentHash,
		lastChanged: file.stat.mtime,
		lastChangedIso: new Date(file.stat.mtime).toISOString()
	};

	if (mimeType) {
		record.mimeType = mimeType;
	}

	if (fileType === "markdown") {
		record.content = fileContent.textContent;

	} else if (mimeType && fileContent.binaryContent) {
		record._attachments = {
			[FILE_ATTACHMENT_ID]: {
				content_type: mimeType,
				data: new Blob([fileContent.binaryContent], { type: mimeType })
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

export async function createLocalFileContentHash(app: App, file: TFile, fileType: VaultFileType) {
	const fileContent = await readVaultFileContent(app, file, fileType);
	return fileContent.contentHash;
}

export function normalizeTextContent(content: string) {
	return content.replace(/\r\n?/g, "\n");
}

export function createTextContentHash(content: string) {
	return createContentHash(new TextEncoder().encode(normalizeTextContent(content)).buffer);
}

export function createBinaryContentHash(content: ArrayBuffer) {
	return createContentHash(content);
}

function normalizeVaultFolder(folder: string) {
	const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
	return trimmed || "/";
}

async function readVaultFileContent(app: App, file: TFile, fileType: VaultFileType) {
	if (fileType === "markdown") {
		const textContent = normalizeTextContent(await app.vault.cachedRead(file));

		return {
			textContent,
			contentHash: await createTextContentHash(textContent)
		};
	}

	const binaryContent = await app.vault.readBinary(file);

	return {
		binaryContent,
		contentHash: await createBinaryContentHash(binaryContent)
	};
}

async function createContentHash(content: ArrayBuffer) {
	const hashBuffer = await crypto.subtle.digest("SHA-256", content);
	return Array.from(new Uint8Array(hashBuffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
