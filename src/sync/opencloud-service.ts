import { requestUrl } from "obsidian";
import {
	NextcloudHttpError,
	NextcloudService,
	type NextcloudConnection,
	type NextcloudRemoteFile,
	type NextcloudWritePrecondition
} from "./nextcloud-service";
import { validateNextcloudFilePath } from "./nextcloud-path";
import { normalizeOpenCloudSpaceId } from "./opencloud-path";
import { Logger } from "../utils/logger";

const logger = new Logger("OpenCloudService");
const TUS_VERSION = "1.0.0";
const TUS_RETRY_DELAYS_MS = [0, 1000, 3000, 5000, 10000];
const METADATA_RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000];

export type OpenCloudAuthType = "app-token" | "bearer";

export interface OpenCloudConnection extends NextcloudConnection {
	backend: "opencloud";
	spaceId: string;
	authType: OpenCloudAuthType;
	token: string;
	tusChunkSizeBytes: number;
}

/**
 * OpenCloud storage implementation using the Space-aware WebDAV endpoint and
 * resumable TUS uploads. Directory management, inventory, downloads, and
 * deletions reuse the hardened WebDAV behavior from NextcloudService.
 */
export class OpenCloudService extends NextcloudService {
	protected override buildWebDavUrlFromRoot(conn: NextcloudConnection, path: string): string {
		const openCloud = asOpenCloudConnection(conn);
		const spaceId = normalizeOpenCloudSpaceId(openCloud.spaceId);
		assertValidSpaceId(spaceId);
		const normalizedPath = path.replace(/^\/+|\/+$/g, "");
		if (normalizedPath) assertValidPath(normalizedPath, false);

		const base = openCloud.url.replace(/\/+$/g, "");
		const segments = normalizedPath
			.split("/")
			.filter(Boolean)
			.map(encodeURIComponent)
			.join("/");
		const suffix = segments
			? `/${segments}${path.endsWith("/") ? "/" : ""}`
			: "/";

		return `${base}/remote.php/dav/spaces/${encodeURIComponent(spaceId)}${suffix}`;
	}

	protected override buildAuthHeaders(conn: NextcloudConnection): Record<string, string> {
		const openCloud = asOpenCloudConnection(conn);
		if (openCloud.authType === "bearer") {
			return { Authorization: `Bearer ${openCloud.token}` };
		}

		return { Authorization: `Basic ${encodeBase64(`${openCloud.username}:${openCloud.token}`)}` };
	}

	override async uploadFile(
		conn: NextcloudConnection,
		vaultFilePath: string,
		content: ArrayBuffer | string,
		contentType: string,
		precondition: NextcloudWritePrecondition = {}
	): Promise<NextcloudRemoteFile> {
		const openCloud = asOpenCloudConnection(conn);
		assertValidPath(vaultFilePath, false);
		const lastSlash = vaultFilePath.lastIndexOf("/");
		const parentDir = lastSlash >= 0 ? vaultFilePath.slice(0, lastSlash) : "";
		const fileName = lastSlash >= 0 ? vaultFilePath.slice(lastSlash + 1) : vaultFilePath;
		if (precondition.ifNoneMatch) {
			try {
				await this.getFileMetadata(openCloud, vaultFilePath);
				throw new NextcloudHttpError("OpenCloud upload precondition failed: HTTP 412", 412);
			} catch (error) {
				if (!(error instanceof NextcloudHttpError) || error.status !== 404) throw error;
			}
		}
		await this.ensureDirectory(openCloud, parentDir);

		const body = typeof content === "string"
			? new TextEncoder().encode(content).buffer
			: content;
		const endpoint = this.buildWebDavUrl(openCloud, parentDir ? `${parentDir}/` : "");
		const creation = await this.openCloudRequest({
			url: endpoint,
			method: "POST",
			headers: {
				...this.buildAuthHeaders(openCloud),
				"Tus-Resumable": TUS_VERSION,
				"Upload-Length": String(body.byteLength),
				"Upload-Metadata": [
					`filename ${encodeBase64(fileName)}`,
					`filetype ${encodeBase64(contentType)}`
				].join(","),
				...buildConditionalHeaders(precondition)
			}
		}, "OpenCloud TUS upload creation");

		if (body.byteLength > 0) {
			const location = getResponseHeader(creation.headers, "location");
			if (!location) {
				throw new Error("OpenCloud did not return a TUS upload location.");
			}
			const uploadUrl = resolveTrustedUploadUrl(location, endpoint);
			await this.uploadTusChunks(openCloud, uploadUrl, body);
		}

		logger.debug("Uploaded file to OpenCloud", { path: vaultFilePath, size: body.byteLength });
		return this.waitForFileMetadata(openCloud, vaultFilePath);
	}

	override async downloadFile(
		conn: NextcloudConnection,
		path: string,
		expectedEtag: string
	) {
		const before = await this.getFileMetadata(conn, path);
		if (before.etag !== expectedEtag) {
			throw new NextcloudHttpError("OpenCloud download precondition failed: HTTP 412", 412);
		}
		const download = await super.downloadFile(conn, path, expectedEtag);
		const after = await this.getFileMetadata(conn, path);
		if (download.etag !== expectedEtag || after.etag !== expectedEtag) {
			throw new NextcloudHttpError("OpenCloud download precondition failed: HTTP 412", 412);
		}
		return download;
	}

	override async deleteFile(
		conn: NextcloudConnection,
		remotePath: string,
		precondition: NextcloudWritePrecondition = {}
	) {
		if (precondition.ifMatch) {
			try {
				const metadata = await this.getFileMetadata(conn, remotePath);
				if (metadata.etag !== precondition.ifMatch) {
					throw new NextcloudHttpError("OpenCloud deletion precondition failed: HTTP 412", 412);
				}
			} catch (error) {
				if (error instanceof NextcloudHttpError && error.status === 404) return "missing" as const;
				throw error;
			}
		}
		return super.deleteFile(conn, remotePath, {});
	}

	private async uploadTusChunks(
		conn: OpenCloudConnection,
		uploadUrl: string,
		content: ArrayBuffer
	): Promise<void> {
		let offset = 0;
		const chunkSize = Math.max(1, conn.tusChunkSizeBytes);

		while (offset < content.byteLength) {
			const end = Math.min(offset + chunkSize, content.byteLength);
			const chunk = content.slice(offset, end);
			offset = await this.uploadTusChunkWithRetry(conn, uploadUrl, chunk, offset, content.byteLength);
		}
	}

	private async uploadTusChunkWithRetry(
		conn: OpenCloudConnection,
		uploadUrl: string,
		chunk: ArrayBuffer,
		offset: number,
		totalSize: number
	): Promise<number> {
		let lastError: unknown;

		for (let attempt = 0; attempt < TUS_RETRY_DELAYS_MS.length; attempt += 1) {
			if (attempt > 0) await wait(TUS_RETRY_DELAYS_MS[attempt] ?? 0);

			try {
				const result = await this.openCloudRequest({
					url: uploadUrl,
					method: "PATCH",
					headers: {
						...this.buildAuthHeaders(conn),
						"Tus-Resumable": TUS_VERSION,
						"Upload-Offset": String(offset),
						"Content-Type": "application/offset+octet-stream"
					},
					body: chunk
				}, "OpenCloud TUS chunk upload");
				return parseTusOffset(result.headers, offset + chunk.byteLength, totalSize);
			} catch (error) {
				lastError = error;
				if (!isRetryableTusError(error) || attempt === TUS_RETRY_DELAYS_MS.length - 1) {
					throw error;
				}

				try {
					const remoteOffset = await this.getTusOffset(conn, uploadUrl, totalSize);
					if (remoteOffset !== offset) return remoteOffset;
				} catch (headError) {
					lastError = headError;
				}
			}
		}

		throw lastError instanceof Error ? lastError : new Error("OpenCloud TUS upload failed.");
	}

	private async getTusOffset(
		conn: OpenCloudConnection,
		uploadUrl: string,
		totalSize: number
	): Promise<number> {
		const result = await this.openCloudRequest({
			url: uploadUrl,
			method: "HEAD",
			headers: {
				...this.buildAuthHeaders(conn),
				"Tus-Resumable": TUS_VERSION
			}
		}, "OpenCloud TUS offset query");
		return parseTusOffset(result.headers, -1, totalSize);
	}

	private async waitForFileMetadata(
		conn: OpenCloudConnection,
		path: string
	): Promise<NextcloudRemoteFile> {
		let lastError: unknown;

		for (const delay of METADATA_RETRY_DELAYS_MS) {
			if (delay > 0) await wait(delay);
			try {
				return await this.getFileMetadata(conn, path);
			} catch (error) {
				lastError = error;
				if (!(error instanceof NextcloudHttpError) || (error.status !== 404 && error.status !== 425)) {
					throw error;
				}
			}
		}

		throw lastError instanceof Error ? lastError : new Error("OpenCloud upload metadata is unavailable.");
	}

	private async openCloudRequest(
		options: {
			url: string;
			method: string;
			headers: Record<string, string>;
			body?: ArrayBuffer;
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

function asOpenCloudConnection(conn: NextcloudConnection): OpenCloudConnection {
	if (
		conn.backend !== "opencloud"
		|| !("spaceId" in conn)
		|| !("authType" in conn)
		|| !("token" in conn)
		|| !("tusChunkSizeBytes" in conn)
	) {
		throw new Error("Invalid OpenCloud connection.");
	}
	return conn as OpenCloudConnection;
}

function assertValidSpaceId(spaceId: string) {
	if (!spaceId || /[\/\\\u0000-\u001f\u007f]/u.test(spaceId)) {
		throw new Error("Invalid OpenCloud Space ID.");
	}
}

function assertValidPath(path: string, allowEmpty: boolean) {
	const normalized = path.replace(/^\/+|\/+$/g, "");
	if (!normalized && allowEmpty) return;
	const validation = validateNextcloudFilePath(normalized);
	if (!validation.valid) {
		throw new Error(`Invalid OpenCloud path (${path}): ${validation.reasons.join(", ")}`);
	}
}

function buildConditionalHeaders(condition: NextcloudWritePrecondition) {
	return {
		...(condition.ifMatch ? { "If-Match": condition.ifMatch } : {}),
		...(condition.ifNoneMatch ? { "If-None-Match": condition.ifNoneMatch } : {})
	};
}

function encodeBase64(value: string) {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function getResponseHeader(headers: Record<string, string> | undefined, name: string) {
	if (!headers) return undefined;
	return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function resolveTrustedUploadUrl(location: string, endpoint: string) {
	const uploadUrl = new URL(location, endpoint);
	if (uploadUrl.origin !== new URL(endpoint).origin) {
		throw new Error("OpenCloud returned a TUS upload location on an unexpected origin.");
	}
	return uploadUrl.toString();
}

function parseTusOffset(
	headers: Record<string, string> | undefined,
	fallback: number,
	totalSize: number
) {
	const value = getResponseHeader(headers, "upload-offset");
	const offset = value === undefined ? fallback : Number(value);
	if (!Number.isInteger(offset) || offset < 0 || offset > totalSize) {
		throw new Error("OpenCloud returned an invalid TUS upload offset.");
	}
	return offset;
}

function isRetryableTusError(error: unknown) {
	return !(error instanceof NextcloudHttpError)
		|| error.status === 408
		|| error.status === 409
		|| error.status === 425
		|| error.status === 429
		|| error.status >= 500;
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

function wait(delayMs: number) {
	return new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
}
