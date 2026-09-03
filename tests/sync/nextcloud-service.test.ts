import { requestUrl } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NextcloudService,
	NextcloudHttpError,
	type NextcloudConnection
} from "../../src/sync/nextcloud-service";
import type { VaultFileRecord } from "../../src/sync/types";

const connection: NextcloudConnection = {
	url: "https://cloud.example.com/",
	username: "alice",
	password: "app-password",
	remotePath: "/Notes/"
};

const requestUrlMock = requestUrl as unknown as ReturnType<typeof vi.fn>;

function response(status: number, text = "", options: { headers?: Record<string, string>; content?: ArrayBuffer } = {}) {
	return {
		status,
		text,
		headers: options.headers ?? { etag: "\"response-etag\"" },
		arrayBuffer: options.content ?? new ArrayBuffer(0)
	} as never;
}

function inventoryXml(entries: Array<{
	href: string;
	directory?: boolean;
	etag?: string;
	size?: number;
	type?: string;
}>, prefix = "d") {
	return `<?xml version="1.0"?><${prefix}:multistatus xmlns:${prefix}="DAV:">${entries.map((entry) =>
		`<${prefix}:response><${prefix}:href>${entry.href}</${prefix}:href><${prefix}:propstat><${prefix}:prop>`
		+ `<${prefix}:resourcetype>${entry.directory ? `<${prefix}:collection/>` : ""}</${prefix}:resourcetype>`
		+ (entry.etag ? `<${prefix}:getetag>${entry.etag}</${prefix}:getetag>` : "")
		+ `<${prefix}:getcontentlength>${entry.size ?? 0}</${prefix}:getcontentlength>`
		+ `<${prefix}:getcontenttype>${entry.type ?? "application/octet-stream"}</${prefix}:getcontenttype>`
		+ `<${prefix}:getlastmodified>Wed, 02 Sep 2026 12:00:00 GMT</${prefix}:getlastmodified>`
		+ `</${prefix}:prop><${prefix}:status>HTTP/1.1 200 OK</${prefix}:status></${prefix}:propstat></${prefix}:response>`
	).join("")}</${prefix}:multistatus>`;
}

function markdownRecord(path: string): VaultFileRecord {
	return {
		_id: `vault-file:${path}`,
		type: "vault-file",
		fileType: "markdown",
		fileName: path.slice(path.lastIndexOf("/") + 1),
		path,
		size: 5,
		contentHash: "hash",
		content: "hello",
		lastChanged: 100,
		lastChangedIso: new Date(100).toISOString()
	};
}

function multistatus(...hrefs: string[]) {
	return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${hrefs.map(
		(href) => `<d:response><d:href>${href}</d:href></d:response>`
	).join("")}</d:multistatus>`;
}

afterEach(() => {
	requestUrlMock.mockReset();
	requestUrlMock.mockRejectedValue(new Error("Unexpected requestUrl call"));
});

describe("NextcloudService push changes", () => {
	it("skips uploads and deletions with invalid Nextcloud paths", async () => {
		const service = new NextcloudService();
		const onProgress = vi.fn();

		const result = await service.pushChanges(connection, {
			records: [markdownRecord("Folder/File\nname.md")],
			deletedPaths: ["Folder/Old\tname.md"]
		}, onProgress);

		expect(result).toEqual({ uploaded: 0, deleted: 0, skipped: 2, errors: 0 });
		expect(requestUrlMock).not.toHaveBeenCalled();
		expect(onProgress).toHaveBeenLastCalledWith({
			current: 2,
			total: 2,
			uploaded: 0,
			deleted: 0,
			skipped: 2
		});
	});

	it("uploads replacements before deleting their old paths", async () => {
		requestUrlMock.mockImplementation(async (options) => {
			if (options.method === "MKCOL") {
				throw { status: 405 };
			}

			if (options.method === "PROPFIND") {
				return response(207, multistatus(
					"/remote.php/webdav/Notes/Old/",
					"/remote.php/webdav/Notes/Old/keep.md"
				));
			}

			return response(204);
		});
		const service = new NextcloudService();

		await service.pushChanges(connection, {
			records: [markdownRecord("New/note.md")],
			deletedPaths: ["Old/note.md"]
		}, vi.fn());

		const methods = requestUrlMock.mock.calls.map(([options]) => options.method);
		expect(methods.indexOf("PUT")).toBeLessThan(methods.indexOf("DELETE"));
	});

	it("deletes empty parent directories deepest first without deleting remotePath", async () => {
		requestUrlMock.mockImplementation(async (options) => {
			if (options.method === "PROPFIND") {
				return response(207, multistatus(new URL(options.url).pathname));
			}

			return response(204);
		});
		const service = new NextcloudService();

		const result = await service.pushChanges(connection, {
			records: [],
			deletedPaths: ["Area/Topic/note.md"]
		}, vi.fn());

		expect(result).toEqual({ uploaded: 0, deleted: 1, skipped: 0, errors: 0 });
		const deletedUrls = requestUrlMock.mock.calls
			.filter(([options]) => options.method === "DELETE")
			.map(([options]) => options.url);
		expect(deletedUrls).toEqual([
			"https://cloud.example.com/remote.php/webdav/Notes/Area/Topic/note.md",
			"https://cloud.example.com/remote.php/webdav/Notes/Area/Topic",
			"https://cloud.example.com/remote.php/webdav/Notes/Area"
		]);
		expect(deletedUrls).not.toContain("https://cloud.example.com/remote.php/webdav/Notes/");
	});

	it("stops cleaning when a parent directory still contains another entry", async () => {
		requestUrlMock.mockImplementation(async (options) => {
			if (options.method === "PROPFIND") {
				return response(207, multistatus(
					new URL(options.url).pathname,
					"/remote.php/webdav/Notes/Area/Topic/keep.md"
				));
			}

			return response(204);
		});
		const service = new NextcloudService();

		await service.pushChanges(connection, {
			records: [],
			deletedPaths: ["Area/Topic/note.md"]
		}, vi.fn());

		expect(requestUrlMock.mock.calls.filter(([options]) => options.method === "DELETE"))
			.toHaveLength(1);
	});

	it("treats an absent file as deleted and still cleans its empty parent", async () => {
		requestUrlMock.mockImplementation(async (options) => {
			if (options.method === "DELETE" && options.url.endsWith("note.md")) {
				throw { status: 404 };
			}

			if (options.method === "PROPFIND") {
				return response(207, multistatus(new URL(options.url).pathname));
			}

			return response(204);
		});
		const service = new NextcloudService();

		const result = await service.pushChanges(connection, {
			records: [],
			deletedPaths: ["Area/note.md"]
		}, vi.fn());

		expect(result.deleted).toBe(1);
		expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
			method: "DELETE",
			url: "https://cloud.example.com/remote.php/webdav/Notes/Area"
		}));
	});

	it("completes the deletion when optional directory cleanup fails", async () => {
		requestUrlMock.mockImplementation(async (options) => {
			if (options.method === "PROPFIND") {
				throw { status: 500 };
			}

			return response(204);
		});
		const service = new NextcloudService();

		const result = await service.pushChanges(connection, {
			records: [],
			deletedPaths: ["Area/note.md"]
		}, vi.fn());

		expect(result).toEqual({ uploaded: 0, deleted: 1, skipped: 0, errors: 0 });
	});

	it("stops optional directory cleanup when a successful listing has no entries", async () => {
		requestUrlMock.mockImplementation(async (options) => {
			if (options.method === "PROPFIND") {
				return response(207, multistatus());
			}

			return response(204);
		});
		const service = new NextcloudService();

		const result = await service.pushChanges(connection, {
			records: [],
			deletedPaths: ["Area/note.md"]
		}, vi.fn());

		expect(result).toEqual({ uploaded: 0, deleted: 1, skipped: 0, errors: 0 });
		expect(requestUrlMock.mock.calls.filter(([options]) => options.method === "DELETE"))
			.toHaveLength(1);
	});

	it("keeps the deletion pending when deleting the file fails", async () => {
		requestUrlMock.mockImplementation(async (options) => {
			if (options.method === "DELETE") {
				throw { status: 500 };
			}

			return response(207, multistatus());
		});
		const service = new NextcloudService();

		const result = await service.pushChanges(connection, {
			records: [],
			deletedPaths: ["Area/note.md"]
		}, vi.fn());

		expect(result).toEqual({ uploaded: 0, deleted: 0, skipped: 0, errors: 1 });
		expect(requestUrlMock.mock.calls.filter(([options]) => options.method === "PROPFIND"))
			.toHaveLength(0);
	});

	it("encodes every path segment", async () => {
		requestUrlMock.mockImplementation(async (options) => {
			if (options.method === "PROPFIND") {
				return response(207, multistatus(
					new URL(options.url).pathname,
					`${new URL(options.url).pathname}keep.md`
				));
			}

			return response(204);
		});
		const service = new NextcloudService();

		await service.pushChanges(connection, {
			records: [],
			deletedPaths: ["Área de trabalho/nota 1.md"]
		}, vi.fn());

		expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
			method: "DELETE",
			url: "https://cloud.example.com/remote.php/webdav/Notes/%C3%81rea%20de%20trabalho/nota%201.md"
		}));
	});
});

describe("NextcloudService WebDAV inventory and conditional requests", () => {
	it("recursively lists files with arbitrary namespace prefixes and decoded segments", async () => {
		requestUrlMock.mockImplementation(async (options) => {
			if (options.url.endsWith("/Notes/")) {
				return response(207, inventoryXml([
					{ href: "/remote.php/webdav/Notes/", directory: true },
					{ href: "/remote.php/webdav/Notes/%C3%81rea%20de%20trabalho/", directory: true },
					{ href: "/remote.php/webdav/Notes/readme.md", etag: "&quot;one&quot;", size: 4, type: "text/markdown" }
				], "x"));
			}
			return response(207, inventoryXml([
				{ href: "/remote.php/webdav/Notes/%C3%81rea%20de%20trabalho/", directory: true },
				{ href: "/remote.php/webdav/Notes/%C3%81rea%20de%20trabalho/nota%201.pdf", etag: "&quot;two&quot;", size: 8, type: "application/pdf" }
			], "z"));
		});

		await expect(new NextcloudService().listFiles(connection)).resolves.toEqual([
			expect.objectContaining({ path: "Área de trabalho/nota 1.pdf", etag: "\"two\"", size: 8 }),
			expect.objectContaining({ path: "readme.md", etag: "\"one\"", size: 4 })
		]);
		expect(requestUrlMock).toHaveBeenCalledTimes(2);
	});

	it("accepts a proven empty root but rejects incomplete, external, and duplicate listings", async () => {
		requestUrlMock.mockResolvedValueOnce(response(207, inventoryXml([
			{ href: "/remote.php/webdav/Notes/", directory: true }
		])));
		await expect(new NextcloudService().listFiles(connection)).resolves.toEqual([]);

		requestUrlMock.mockResolvedValueOnce(response(207, inventoryXml([
			{ href: "https://evil.example/remote.php/webdav/Notes/", directory: true }
		])));
		await expect(new NextcloudService().listFiles(connection)).rejects.toThrow("external href");

		requestUrlMock.mockResolvedValueOnce(response(207, inventoryXml([
			{ href: "/remote.php/webdav/Notes/", directory: true },
			{ href: "/remote.php/webdav/Notes/a.md", etag: "one" },
			{ href: "/remote.php/webdav/Notes/a.md", etag: "two" }
		])));
		await expect(new NextcloudService().listFiles(connection)).rejects.toThrow("duplicate path");
	});

	it("rejects missing ETags, malformed encoding, and HTTP failures", async () => {
		requestUrlMock.mockResolvedValueOnce(response(207, inventoryXml([
			{ href: "/remote.php/webdav/Notes/", directory: true },
			{ href: "/remote.php/webdav/Notes/a.md" }
		])));
		await expect(new NextcloudService().listFiles(connection)).rejects.toThrow("did not return an ETag");

		requestUrlMock.mockResolvedValueOnce(response(207, inventoryXml([
			{ href: "/remote.php/webdav/Notes/", directory: true },
			{ href: "/remote.php/webdav/Notes/%E0%A4%A.md", etag: "one" }
		])));
		await expect(new NextcloudService().listFiles(connection)).rejects.toThrow("malformed encoded path");

		requestUrlMock.mockResolvedValueOnce(response(401));
		await expect(new NextcloudService().listFiles(connection)).rejects.toMatchObject({ status: 401 });
	});

	it("downloads bytes with If-Match and exposes conditional 412 failures", async () => {
		const bytes = new Uint8Array([0, 1, 2, 255]).buffer;
		requestUrlMock.mockResolvedValueOnce(response(200, "", {
			headers: { ETag: "\"v2\"", "Content-Type": "application/pdf" },
			content: bytes
		}));
		const service = new NextcloudService();
		await expect(service.downloadFile(connection, "a.pdf", "\"v2\"")).resolves.toMatchObject({
			etag: "\"v2\"",
			size: 4,
			contentType: "application/pdf"
		});
		expect(requestUrlMock).toHaveBeenLastCalledWith(expect.objectContaining({
			method: "GET",
			headers: expect.objectContaining({ "If-Match": "\"v2\"" })
		}));

		requestUrlMock.mockResolvedValueOnce(response(412));
		await expect(service.deleteFile(connection, "a.pdf", { ifMatch: "\"v2\"" }))
			.rejects.toBeInstanceOf(NextcloudHttpError);
	});
});
