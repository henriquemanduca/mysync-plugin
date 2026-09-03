import { requestUrl } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NextcloudService,
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

function response(status: number, text = "") {
	return { status, text } as never;
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
