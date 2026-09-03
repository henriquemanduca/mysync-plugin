import { requestUrl } from "obsidian";
import type { VaultFileRecord } from "./types";
import { validateNextcloudFilePath } from "./nextcloud-path";
import { Logger } from "../utils/logger";

const logger = new Logger("NextcloudService");

export interface NextcloudConnection {
	url: string;
	username: string;
	password: string;
	remotePath: string;
}

export interface NextcloudPushResult {
	uploaded: number;
	deleted: number;
	skipped: number;
	errors: number;
}

export interface NextcloudPushProgress {
	current: number;
	total: number;
	uploaded: number;
	deleted: number;
	skipped: number;
}

export interface NextcloudPushPlan {
	records: VaultFileRecord[];
	deletedPaths: string[];
}

type NextcloudDeleteStatus = "deleted" | "missing";
type NextcloudDirectoryState = "empty" | "not-empty" | "missing" | "unknown";

export class NextcloudService {
	/**
	 * Tests the connection to the Nextcloud server via PROPFIND Depth:0.
	 * Throws if the connection fails.
	 */
	async testConnection(conn: NextcloudConnection): Promise<void> {
		const url = this.buildWebDavUrl(conn, "");

		const result = await requestUrl({
			url,
			method: "PROPFIND",
			headers: {
				...this.buildAuthHeaders(conn),
				"Depth": "0"
			}
		});

		if (result.status < 200 || result.status >= 300) {
			throw new Error(`Nextcloud connection failed: HTTP ${result.status}`);
		}
	}

	/**
	 * Creates a directory and all its parents via recursive MKCOL.
	 * Silently succeeds if directories already exist.
	 * This ensures both the base remotePath and the vault relative dirPath are created.
	 */
	async ensureDirectory(
		conn: NextcloudConnection,
		dirPath: string
	): Promise<void> {
		const remotePath = conn.remotePath.replace(/^\/+|\/+$/g, "");
		const relativePath = dirPath.replace(/^\/+|\/+$/g, "");

		let combinedPath = "";
		if (remotePath && relativePath) {
			combinedPath = `${remotePath}/${relativePath}`;
		} else if (remotePath) {
			combinedPath = remotePath;
		} else if (relativePath) {
			combinedPath = relativePath;
		}

		if (!combinedPath) {
			return;
		}

		const segments = combinedPath.split("/");
		let currentPath = "";
		const base = conn.url.replace(/\/+$/, "");

		for (const segment of segments) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			
			const encodedSegments = currentPath.split("/").map(encodeURIComponent).join("/");
			const url = `${base}/remote.php/webdav/${encodedSegments}/`;

			try {
				const result = await requestUrl({
					url,
					method: "MKCOL",
					headers: this.buildAuthHeaders(conn)
				});

				if (result.status === 405) {
					continue;
				}

				if (result.status < 200 || result.status >= 300) {
					throw new Error(`Nextcloud directory creation failed: HTTP ${result.status}`);
				}

				logger.debug("Created remote directory", { path: currentPath });
			} catch (error) {
				const status = getHttpStatus(error);

				// 405 Method Not Allowed = directory already exists
				if (status === 405) {
					continue;
				}

				throw error;
			}
		}
	}

	/**
	 * Uploads a file via PUT.
	 * Automatically creates parent directories if they don't exist.
	 */
	async uploadFile(
		conn: NextcloudConnection,
		vaultFilePath: string,
		content: ArrayBuffer | string,
		contentType: string
	): Promise<void> {
		const lastSlash = vaultFilePath.lastIndexOf("/");
		const parentDir = lastSlash !== -1 ? vaultFilePath.substring(0, lastSlash) : "";

		await this.ensureDirectory(conn, parentDir);

		const url = this.buildWebDavUrl(conn, vaultFilePath);
		const body = typeof content === "string"
			? new TextEncoder().encode(content).buffer
			: content;

		const result = await requestUrl({
			url,
			method: "PUT",
			headers: {
				...this.buildAuthHeaders(conn),
				"Content-Type": contentType
			},
			body
		});

		if (result.status < 200 || result.status >= 300) {
			throw new Error(`Nextcloud upload failed: HTTP ${result.status}`);
		}

		logger.debug("Uploaded file to Nextcloud", { path: vaultFilePath });
	}

	/**
	 * Deletes a remote file via DELETE.
	 * Silently succeeds if the file does not exist (404).
	 */
	async deleteFile(
		conn: NextcloudConnection,
		remotePath: string
	): Promise<NextcloudDeleteStatus> {
		const status = await this.deletePath(conn, remotePath);

		logger.debug(
			status === "deleted"
				? "Deleted file from Nextcloud"
				: "File already absent from Nextcloud",
			{ path: remotePath }
		);

		return status;
	}

	/**
	 * Orchestrates the push of VaultFileRecords to Nextcloud.
	 * Uploads each record sequentially (throttled to avoid rate-limiting).
	 */
	async pushChanges(
		conn: NextcloudConnection,
		plan: NextcloudPushPlan,
		onProgress: (progress: NextcloudPushProgress) => void
	): Promise<NextcloudPushResult> {
		let uploaded = 0;
		let deleted = 0;
		let skipped = 0;
		let errors = 0;
		const total = plan.records.length + plan.deletedPaths.length;

		for (const record of plan.records) {
			const pathValidation = validateNextcloudFilePath(record.path);

			if (!pathValidation.valid) {
				logger.warn("Skipped file with an invalid Nextcloud path", undefined, {
					path: record.path,
					reasons: pathValidation.reasons
				});
				skipped++;
				onProgress({ current: uploaded + deleted + skipped + errors, total, uploaded, deleted, skipped });
				continue;
			}

			const extracted = extractRecordContent(record);

			if (!extracted) {
				logger.debug("Skipped file without uploadable content", {
					path: record.path,
					fileType: record.fileType
				});
				skipped++;
				onProgress({ current: uploaded + deleted + skipped + errors, total, uploaded, deleted, skipped });
				continue;
			}

			try {
				const { content, contentType } = await extracted.resolve();

				await this.uploadFile(conn, record.path, content, contentType);
				uploaded++;
			} catch (error) {
				logger.error("Failed to upload file to Nextcloud", error, {
					path: record.path
				});
				errors++;
			}

			onProgress({
				current: uploaded + deleted + skipped + errors,
				total,
				uploaded,
				deleted,
				skipped
			});
		}

		for (const path of plan.deletedPaths) {
			const pathValidation = validateNextcloudFilePath(path);

			if (!pathValidation.valid) {
				logger.warn("Skipped deletion with an invalid Nextcloud path", undefined, {
					path,
					reasons: pathValidation.reasons
				});
				skipped++;
				onProgress({ current: uploaded + deleted + skipped + errors, total, uploaded, deleted, skipped });
				continue;
			}

			try {
				await this.deleteFile(conn, path);
				deleted += 1;
			} catch (error) {
				logger.error("Failed to delete file from Nextcloud", error, { path });
				errors += 1;
				onProgress({
					current: uploaded + deleted + skipped + errors,
					total,
					uploaded,
					deleted,
					skipped
				});
				continue;
			}

			try {
				await this.removeEmptyParentDirectories(conn, path);
			} catch (error) {
				logger.warn("Failed to clean empty Nextcloud directories", error, { path });
			}

			onProgress({
				current: uploaded + deleted + skipped + errors,
				total,
				uploaded,
				deleted,
				skipped
			});
		}

		return { uploaded, deleted, skipped, errors };
	}

	private async removeEmptyParentDirectories(
		conn: NextcloudConnection,
		filePath: string
	) {
		let parentPath = getParentPath(filePath);

		while (parentPath) {
			const directoryState = await this.getDirectoryState(conn, parentPath);

			if (directoryState === "missing") {
				parentPath = getParentPath(parentPath);
				continue;
			}

			if (directoryState === "not-empty") {
				return;
			}

			if (directoryState === "unknown") {
				return;
			}

			const deleteStatus = await this.deletePath(conn, parentPath);
			logger.debug(
				deleteStatus === "deleted"
					? "Deleted empty directory from Nextcloud"
					: "Empty directory already absent from Nextcloud",
				{ path: parentPath }
			);
			parentPath = getParentPath(parentPath);
		}
	}

	private async getDirectoryState(
		conn: NextcloudConnection,
		directoryPath: string
	): Promise<NextcloudDirectoryState> {
		const url = this.buildWebDavUrl(conn, `${directoryPath.replace(/\/+$/g, "")}/`);
		let result;

		try {
			result = await requestUrl({
				url,
				method: "PROPFIND",
				headers: {
					...this.buildAuthHeaders(conn),
					"Depth": "1"
				}
			});
		} catch (error) {
			if (getHttpStatus(error) === 404) {
				return "missing";
			}

			throw error;
		}

		if (result.status < 200 || result.status >= 300) {
			throw new Error(`Nextcloud directory listing failed: HTTP ${result.status}`);
		}

		const requestedPath = normalizeUrlPath(url);
		const hrefs = extractWebDavHrefs(result.text);

		if (hrefs.length === 0) {
			logger.warn("Stopped empty directory cleanup because the listing returned no entries", undefined, {
				path: directoryPath,
				status: result.status
			});
			return "unknown";
		}

		return hrefs.some((href) => normalizeUrlPath(href, url) !== requestedPath)
			? "not-empty"
			: "empty";
	}

	private async deletePath(
		conn: NextcloudConnection,
		path: string
	): Promise<NextcloudDeleteStatus> {
		const url = this.buildWebDavUrl(conn, path);

		try {
			const result = await requestUrl({
				url,
				method: "DELETE",
				headers: this.buildAuthHeaders(conn)
			});

			if (result.status === 404) {
				return "missing";
			}

			if (result.status < 200 || result.status >= 300) {
				throw new Error(`Nextcloud deletion failed: HTTP ${result.status}`);
			}

			return "deleted";
		} catch (error) {
			if (getHttpStatus(error) === 404) {
				return "missing";
			}

			throw error;
		}
	}

	/**
	 * Builds the full WebDAV URL for a given path.
	 * Example: https://cloud.example.com/remote.php/webdav/Notes/subfolder/file.md
	 */
	private buildWebDavUrl(conn: NextcloudConnection, path: string): string {
		const base = conn.url.replace(/\/+$/, "");
		const remotePath = conn.remotePath.replace(/^\/+|\/+$/g, "");
		const filePath = path.replace(/^\/+/, "");

		let segments: string;

		if (remotePath && filePath) {
			segments = `${remotePath}/${filePath}`;
		} else if (remotePath) {
			segments = `${remotePath}/`;
		} else if (filePath) {
			segments = filePath;
		} else {
			segments = "";
		}

		const encodedSegments = segments.split("/").map(encodeURIComponent).join("/");
		return `${base}/remote.php/webdav/${encodedSegments}`;
	}

	private buildAuthHeaders(conn: NextcloudConnection): Record<string, string> {
		const token = btoa(`${conn.username}:${conn.password}`);

		return {
			"Authorization": `Basic ${token}`
		};
	}
}

/**
 * Extracts uploadable content from a VaultFileRecord.
 * Returns null for records without stored content (e.g. "other" file type
 * without a known MIME type).
 */
function extractRecordContent(
	record: VaultFileRecord
): { resolve: () => Promise<{ content: ArrayBuffer | string; contentType: string }> } | null {
	if (record.fileType === "markdown" && typeof record.content === "string") {
		return {
			resolve: async () => ({
				content: record.content!,
				contentType: "text/markdown; charset=utf-8"
			})
		};
	}

	const attachment = record._attachments?.file;

	if (attachment && "data" in attachment && attachment.data instanceof Blob) {
		return {
			resolve: async () => ({
				content: await attachment.data.arrayBuffer(),
				contentType: attachment.content_type || "application/octet-stream"
			})
		};
	}

	return null;
}

function getHttpStatus(error: unknown): number | null {
	if (
		error !== null
		&& typeof error === "object"
		&& "status" in error
		&& typeof (error as Record<string, unknown>).status === "number"
	) {
		return Number((error as Record<string, unknown>).status);
	}

	return null;
}

function getParentPath(path: string) {
	const normalized = path.replace(/^\/+|\/+$/g, "");
	const lastSlash = normalized.lastIndexOf("/");
	return lastSlash < 0 ? "" : normalized.slice(0, lastSlash);
}

function extractWebDavHrefs(xml: string) {
	const hrefs: string[] = [];
	const pattern = /<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/gi;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(xml)) !== null) {
		const href = match[1]?.trim();

		if (href) {
			hrefs.push(decodeXmlEntities(href));
		}
	}

	return hrefs;
}

function decodeXmlEntities(value: string) {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;|&apos;/g, "'");
}

function normalizeUrlPath(value: string, base?: string) {
	const pathname = new URL(value, base).pathname.replace(/\/+$/g, "");

	try {
		return decodeURIComponent(pathname);
	} catch {
		return pathname;
	}
}
