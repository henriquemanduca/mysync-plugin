import { requestUrl } from "obsidian";
import { XMLParser } from "fast-xml-parser";
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
	preconditions?: Record<string, NextcloudWritePrecondition>;
}

export interface NextcloudWritePrecondition {
	ifMatch?: string;
	ifNoneMatch?: "*";
}

export interface NextcloudRemoteFile {
	path: string;
	etag: string;
	lastModified?: string;
	size: number;
	contentType?: string;
}

export interface NextcloudDownload extends NextcloudRemoteFile {
	content: ArrayBuffer;
}

export class NextcloudHttpError extends Error {
	constructor(message: string, public readonly status: number) {
		super(message);
		this.name = "NextcloudHttpError";
	}
}

type NextcloudDeleteStatus = "deleted" | "missing";
type NextcloudDirectoryState = "empty" | "not-empty" | "missing" | "unknown";

export class NextcloudService {
	private ensuredDirectories = new Set<string>();

	async listFiles(conn: NextcloudConnection): Promise<NextcloudRemoteFile[]> {
		const rootUrl = this.buildWebDavUrl(conn, "");
		const rootSegments = decodeUrlSegments(new URL(rootUrl).pathname);
		const pendingDirectories = [""];
		const visitedDirectories = new Set<string>();
		const files = new Map<string, NextcloudRemoteFile>();

		const processDirectory = async (directoryPath: string): Promise<string[]> => {
			const url = this.buildWebDavUrl(conn, directoryPath ? `${directoryPath}/` : "");
			const result = await this.request({
				url,
				method: "PROPFIND",
				headers: {
					...this.buildAuthHeaders(conn),
					Depth: "1",
					"Content-Type": "application/xml; charset=utf-8"
				},
				body: PROPFIND_BODY
			}, "Nextcloud directory listing");
			const responses = parseMultiStatus(result.text);
			if (responses.length === 0) {
				throw new Error(`Nextcloud returned an empty or incomplete listing for ${directoryPath || "/"}.`);
			}

			let foundSelf = false;
			const subdirs: string[] = [];
			for (const response of responses) {
				const relativePath = getSafeRelativeHrefPath(response.href, url, rootSegments);
				const normalizedDirectory = directoryPath.replace(/\/+$/g, "");
				if (relativePath === normalizedDirectory) {
					foundSelf = true;
					if (!response.isCollection) {
						throw new Error(`Nextcloud remote folder is not a directory: ${directoryPath || "/"}`);
					}
					continue;
				}

				const parent = getParentPath(relativePath);
				if (parent !== normalizedDirectory) {
					throw new Error(`Nextcloud returned an entry outside the requested directory: ${relativePath}`);
				}
				const validation = validateNextcloudFilePath(relativePath);
				if (!validation.valid) {
					throw new Error(`Nextcloud returned an invalid path (${relativePath}): ${validation.reasons.join(", ")}`);
				}

				if (response.isCollection) {
					subdirs.push(relativePath);
					continue;
				}

				if (!response.etag) {
					throw new Error(`Nextcloud did not return an ETag for ${relativePath}.`);
				}
				if (files.has(relativePath)) {
					throw new Error(`Nextcloud listing contains a duplicate path: ${relativePath}`);
				}
				files.set(relativePath, {
					path: relativePath,
					etag: response.etag,
					lastModified: response.lastModified,
					size: response.size,
					contentType: response.contentType
				});
			}

			if (!foundSelf) {
				throw new Error(`Nextcloud listing is incomplete for ${directoryPath || "/"}.`);
			}

			return subdirs;
		};

		const CONCURRENCY = 4;
		let activeCount = 0;
		let queueIndex = 0;
		let firstError: unknown = null;

		await new Promise<void>((resolve, reject) => {
			const tryNext = () => {
				if (firstError) {
					if (activeCount === 0) reject(firstError);
					return;
				}
				if (queueIndex >= pendingDirectories.length) {
					if (activeCount === 0) resolve();
					return;
				}
				while (activeCount < CONCURRENCY && queueIndex < pendingDirectories.length && !firstError) {
					const dir = pendingDirectories[queueIndex++]!;
					if (visitedDirectories.has(dir)) {
						firstError = new Error(`Nextcloud listing contains a duplicate directory: ${dir || "/"}`);
						if (activeCount === 0) reject(firstError);
						return;
					}
					visitedDirectories.add(dir);
					activeCount++;

					processDirectory(dir)
						.then((subdirs) => {
							for (const sub of subdirs) {
								pendingDirectories.push(sub);
							}
							activeCount--;
							tryNext();
						})
						.catch((err) => {
							if (!firstError) firstError = err;
							activeCount--;
							tryNext();
						});
				}
			};

			tryNext();
		});

		return Array.from(files.values()).sort((left, right) => left.path.localeCompare(right.path));
	}

	async getFileMetadata(conn: NextcloudConnection, path: string): Promise<NextcloudRemoteFile> {
		assertValidFilePath(path);
		const url = this.buildWebDavUrl(conn, path);
		const result = await this.request({
			url,
			method: "PROPFIND",
			headers: {
				...this.buildAuthHeaders(conn),
				Depth: "0",
				"Content-Type": "application/xml; charset=utf-8"
			},
			body: PROPFIND_BODY
		}, "Nextcloud metadata request");
		const responses = parseMultiStatus(result.text);
		if (responses.length !== 1 || responses[0]?.isCollection || !responses[0]?.etag) {
			throw new Error(`Nextcloud returned incomplete metadata for ${path}.`);
		}
		const item = responses[0]!;
		return {
			path,
			etag: item.etag!,
			lastModified: item.lastModified,
			size: item.size,
			contentType: item.contentType
		};
	}

	async downloadFile(
		conn: NextcloudConnection,
		path: string,
		expectedEtag: string
	): Promise<NextcloudDownload> {
		assertValidFilePath(path);
		const result = await this.request({
			url: this.buildWebDavUrl(conn, path),
			method: "GET",
			headers: {
				...this.buildAuthHeaders(conn),
				"If-Match": expectedEtag
			}
		}, "Nextcloud download");
		const etag = getResponseHeader(result.headers, "etag")
			?? getResponseHeader(result.headers, "oc-etag")
			?? expectedEtag;
		return {
			path,
			etag,
			lastModified: getResponseHeader(result.headers, "last-modified"),
			size: result.arrayBuffer.byteLength,
			contentType: getResponseHeader(result.headers, "content-type"),
			content: result.arrayBuffer
		};
	}
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
		assertValidRemotePath(conn.remotePath);
		if (dirPath) assertValidFilePath(dirPath);
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

		const base = conn.url.replace(/\/+$/, "");
		const fullCacheKey = `${base}|${combinedPath}`;
		if (this.ensuredDirectories.has(fullCacheKey)) {
			return;
		}

		const segments = combinedPath.split("/");
		let currentPath = "";

		for (const segment of segments) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			const segmentCacheKey = `${base}|${currentPath}`;
			if (this.ensuredDirectories.has(segmentCacheKey)) {
				continue;
			}
			
			const encodedSegments = currentPath.split("/").map(encodeURIComponent).join("/");
			const url = `${base}/remote.php/webdav/${encodedSegments}/`;

			try {
				const result = await requestUrl({
					url,
					method: "MKCOL",
					headers: this.buildAuthHeaders(conn)
				});

				if (result.status === 405) {
					this.ensuredDirectories.add(segmentCacheKey);
					continue;
				}

				if (result.status < 200 || result.status >= 300) {
					throw new Error(`Nextcloud directory creation failed: HTTP ${result.status}`);
				}

				this.ensuredDirectories.add(segmentCacheKey);
				logger.debug("Created remote directory", { path: currentPath });
			} catch (error) {
				const status = getHttpStatus(error);

				// 405 Method Not Allowed = directory already exists
				if (status === 405) {
					this.ensuredDirectories.add(segmentCacheKey);
					continue;
				}

				throw error;
			}
		}
		this.ensuredDirectories.add(fullCacheKey);
	}

	/**
	 * Uploads a file via PUT.
	 * Automatically creates parent directories if they don't exist.
	 */
	async uploadFile(
		conn: NextcloudConnection,
		vaultFilePath: string,
		content: ArrayBuffer | string,
		contentType: string,
		precondition: NextcloudWritePrecondition = {}
	): Promise<NextcloudRemoteFile> {
		assertValidFilePath(vaultFilePath);
		const lastSlash = vaultFilePath.lastIndexOf("/");
		const parentDir = lastSlash !== -1 ? vaultFilePath.substring(0, lastSlash) : "";

		await this.ensureDirectory(conn, parentDir);

		const url = this.buildWebDavUrl(conn, vaultFilePath);
		const body = typeof content === "string"
			? new TextEncoder().encode(content).buffer
			: content;

		const result = await this.request({
			url,
			method: "PUT",
			headers: {
				...this.buildAuthHeaders(conn),
				"Content-Type": contentType,
				...buildConditionalHeaders(precondition)
			},
			body
		}, "Nextcloud upload");

		logger.debug("Uploaded file to Nextcloud", { path: vaultFilePath });
		const etag = getResponseHeader(result.headers, "etag")
			?? getResponseHeader(result.headers, "oc-etag");
		return etag
			? {
				path: vaultFilePath,
				etag,
				lastModified: getResponseHeader(result.headers, "last-modified"),
				size: body.byteLength,
				contentType
			}
			: this.getFileMetadata(conn, vaultFilePath);
	}

	/**
	 * Deletes a remote file via DELETE.
	 * Silently succeeds if the file does not exist (404).
	 */
	async deleteFile(
		conn: NextcloudConnection,
		remotePath: string,
		precondition: NextcloudWritePrecondition = {}
	): Promise<NextcloudDeleteStatus> {
		assertValidFilePath(remotePath);
		const status = await this.deletePath(conn, remotePath, precondition);

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

				await this.uploadFile(conn, record.path, content, contentType, plan.preconditions?.[record.path]);
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
				await this.deleteFile(conn, path, plan.preconditions?.[path]);
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
		path: string,
		precondition: NextcloudWritePrecondition = {}
	): Promise<NextcloudDeleteStatus> {
		this.ensuredDirectories.clear();
		const url = this.buildWebDavUrl(conn, path);

		try {
			const result = await this.request({
				url,
				method: "DELETE",
				headers: {
					...this.buildAuthHeaders(conn),
					...buildConditionalHeaders(precondition)
				}
			}, "Nextcloud deletion");

			return "deleted";
		} catch (error) {
			if ((error instanceof NextcloudHttpError && error.status === 404) || getHttpStatus(error) === 404) {
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
		assertValidRemotePath(conn.remotePath);
		if (path.replace(/^\/+|\/+$/g, "")) assertValidFilePath(path.replace(/^\/+|\/+$/g, ""));
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

	private async request(
		options: {
			url: string;
			method?: string;
			headers?: Record<string, string>;
			body?: string | ArrayBuffer;
		},
		operation: string
	): Promise<Awaited<ReturnType<typeof requestUrl>>> {
		try {
			const result = await requestUrl({ ...options, throw: false });
			if (result.status < 200 || result.status >= 300) {
				throw new NextcloudHttpError(`${operation} failed: HTTP ${result.status}`, result.status);
			}
			return result;
		} catch (error) {
			if (error instanceof NextcloudHttpError) throw error;
			const status = getHttpStatus(error);
			if (status !== null) {
				throw new NextcloudHttpError(`${operation} failed: HTTP ${status}`, status);
			}
			throw error;
		}
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
	try {
		const parsed = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(xml);
		const responses = toArray(asRecord(asRecord(parsed)?.multistatus)?.response);
		return responses.flatMap((raw) => {
			const href = asString(asRecord(raw)?.href)?.trim();
			return href ? [href] : [];
		});
	} catch {
		return [];
	}
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getlastmodified/><d:getcontentlength/><d:getcontenttype/><d:resourcetype/></d:prop></d:propfind>`;

interface ParsedWebDavResponse {
	href: string;
	isCollection: boolean;
	etag?: string;
	lastModified?: string;
	size: number;
	contentType?: string;
}

function parseMultiStatus(xml: string): ParsedWebDavResponse[] {
	let parsed: unknown;
	try {
		parsed = new XMLParser({
			removeNSPrefix: true,
			ignoreAttributes: false,
			parseTagValue: false,
			trimValues: true
		}).parse(xml);
		} catch (error) {
			throw new Error(`Nextcloud returned malformed WebDAV XML: ${String(error)}`);
	}
	const root = asRecord(parsed)?.multistatus;
	const responses = toArray(asRecord(root)?.response);
	if (!asRecord(root) || responses.length === 0) return [];

	return responses.map((raw) => {
		const response = asRecord(raw);
		const href = asString(response?.href);
		if (!href) throw new Error("Nextcloud WebDAV response is missing href.");
		const successful = toArray(response?.propstat).map(asRecord).find((propstat) => {
			const status = asString(propstat?.status);
			return !status || /\s2\d\d\s/.test(` ${status} `);
		});
		const prop = asRecord(successful?.prop);
		if (!prop) throw new Error(`Nextcloud WebDAV response is missing successful properties for ${href}.`);
		const resourceType = asRecord(prop.resourcetype);
		const sizeValue = Number(asString(prop.getcontentlength) ?? "0");
		if (!Number.isFinite(sizeValue) || sizeValue < 0) {
			throw new Error(`Nextcloud returned an invalid content length for ${href}.`);
		}
		return {
			href,
			isCollection: resourceType !== null && Object.prototype.hasOwnProperty.call(resourceType, "collection"),
			etag: asString(prop.getetag),
			lastModified: asString(prop.getlastmodified),
			size: sizeValue,
			contentType: asString(prop.getcontenttype)
		};
	});
}

function getSafeRelativeHrefPath(href: string, baseUrl: string, rootSegments: string[]) {
	let url: URL;
	try {
		url = new URL(href, baseUrl);
	} catch (error) {
		throw new Error(`Nextcloud returned an invalid href (${href}): ${String(error)}`);
	}
	const base = new URL(baseUrl);
	if (url.origin !== base.origin) throw new Error(`Nextcloud returned an external href: ${href}`);
	const segments = decodeUrlSegments(url.pathname);
	if (segments.length < rootSegments.length || rootSegments.some((part, index) => segments[index] !== part)) {
		throw new Error(`Nextcloud returned a path outside the remote folder: ${href}`);
	}
	const relative = segments.slice(rootSegments.length);
	if (relative.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))) {
		throw new Error(`Nextcloud returned an unsafe path: ${href}`);
	}
	return relative.join("/");
}

function decodeUrlSegments(pathname: string) {
	return pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).map((segment) => {
		try {
			return decodeURIComponent(segment);
		} catch (error) {
			throw new Error(`Nextcloud returned a malformed encoded path (${pathname}): ${String(error)}`);
		}
	});
}

function buildConditionalHeaders(condition: NextcloudWritePrecondition) {
	return {
		...(condition.ifMatch ? { "If-Match": condition.ifMatch } : {}),
		...(condition.ifNoneMatch ? { "If-None-Match": condition.ifNoneMatch } : {})
	};
}

function assertValidFilePath(path: string) {
	const normalized = path.replace(/\/+$/g, "");
	const validation = validateNextcloudFilePath(normalized);
	if (!validation.valid) {
		throw new Error(`Invalid Nextcloud path (${path}): ${validation.reasons.join(", ")}`);
	}
}

function assertValidRemotePath(path: string) {
	const normalized = path.replace(/^\/+|\/+$/g, "");
	if (normalized) assertValidFilePath(normalized);
}

function getResponseHeader(headers: Record<string, string> | undefined, name: string) {
	if (!headers) return undefined;
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
	return entry?.[1];
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown) {
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function toArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function normalizeUrlPath(value: string, base?: string) {
	const pathname = new URL(value, base).pathname.replace(/\/+$/g, "");

	try {
		return decodeURIComponent(pathname);
	} catch {
		return pathname;
	}
}
