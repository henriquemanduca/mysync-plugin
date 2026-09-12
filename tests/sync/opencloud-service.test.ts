import { requestUrl } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	OpenCloudService,
	type OpenCloudConnection
} from "../../src/sync/opencloud-service";

const bearerConnection: OpenCloudConnection = {
	backend: "opencloud",
	url: "https://cloud.example.com/",
	spaceId: "storage-users-1$personal-id",
	authType: "bearer",
	username: "",
	password: "bearer-token",
	token: "bearer-token",
	remotePath: "/Notes/",
	tusChunkSizeBytes: 3
};

const requestUrlMock = requestUrl as unknown as ReturnType<typeof vi.fn>;

function response(
	status: number,
	text = "",
	headers: Record<string, string> = {},
	content = new ArrayBuffer(0)
) {
	return { status, text, headers, arrayBuffer: content } as never;
}

function metadataXml(etag: string) {
	return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>`
		+ `<d:href>/remote.php/dav/spaces/storage-users-1%24personal-id/Notes/Folder/note.md</d:href>`
		+ `<d:propstat><d:prop><d:getetag>${etag}</d:getetag>`
		+ `<d:getcontentlength>5</d:getcontentlength><d:getcontenttype>text/plain</d:getcontenttype>`
		+ `<d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status>`
		+ `</d:propstat></d:response></d:multistatus>`;
}

afterEach(() => {
	requestUrlMock.mockReset();
	requestUrlMock.mockRejectedValue(new Error("Unexpected requestUrl call"));
});

describe("OpenCloudService", () => {
	it("normalizes a Space ID copied from an encoded WebDAV URL", async () => {
		requestUrlMock.mockResolvedValueOnce(response(207));
		const connection: OpenCloudConnection = {
			...bearerConnection,
			spaceId: "storage-users-1%24personal-id",
			remotePath: "/"
		};

		await new OpenCloudService().testConnection(connection);

		expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
			url: "https://cloud.example.com/remote.php/dav/spaces/storage-users-1%24personal-id/"
		}));
		expect(requestUrlMock.mock.calls[0]?.[0].url).not.toContain("%2524");
	});

	it("tests a Space connection with App Token basic authentication", async () => {
		requestUrlMock.mockResolvedValueOnce(response(207));
		const connection: OpenCloudConnection = {
			...bearerConnection,
			authType: "app-token",
			username: "alice",
			token: "app-token"
		};

		await new OpenCloudService().testConnection(connection);

		expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
			url: "https://cloud.example.com/remote.php/dav/spaces/storage-users-1%24personal-id/Notes/",
			method: "PROPFIND",
			headers: expect.objectContaining({
				Authorization: `Basic ${btoa("alice:app-token")}`,
				Depth: "0"
			})
		}));
	});

	it("uploads nested content in resumable TUS chunks through the Space endpoint", async () => {
		let patchCalls = 0;
		requestUrlMock.mockImplementation(async (options) => {
			if (options.method === "MKCOL") return response(201);
			if (options.method === "POST") {
				return response(201, "", { Location: "https://cloud.example.com/data/upload-token" });
			}
			if (options.method === "PATCH") {
				patchCalls += 1;
				return response(204, "", { "Upload-Offset": patchCalls === 1 ? "3" : "5" });
			}
			if (options.method === "PROPFIND") {
				return response(207, metadataXml("&quot;uploaded&quot;"));
			}
			throw new Error(`Unexpected ${options.method} request`);
		});

		await expect(new OpenCloudService().uploadFile(
			bearerConnection,
			"Folder/note.md",
			"hello",
			"text/plain"
		)).resolves.toMatchObject({
			path: "Folder/note.md",
			etag: "\"uploaded\"",
			size: 5
		});

		const post = requestUrlMock.mock.calls.find(([options]) => options.method === "POST")?.[0];
		expect(post).toMatchObject({
			url: "https://cloud.example.com/remote.php/dav/spaces/storage-users-1%24personal-id/Notes/Folder/",
			headers: expect.objectContaining({
				Authorization: "Bearer bearer-token",
				"Tus-Resumable": "1.0.0",
				"Upload-Length": "5",
				"Upload-Metadata": `filename ${btoa("note.md")},filetype ${btoa("text/plain")}`
			})
		});
		const patches = requestUrlMock.mock.calls.filter(([options]) => options.method === "PATCH");
		expect(patches.map(([options]) => options.headers?.["Upload-Offset"])).toEqual(["0", "3"]);
		expect(patches.map(([options]) => (options.body as ArrayBuffer).byteLength)).toEqual([3, 2]);
	});

	it("recovers the server offset after an interrupted TUS chunk", async () => {
		let firstPatch = true;
		requestUrlMock.mockImplementation(async (options) => {
			if (options.method === "MKCOL") return response(201);
			if (options.method === "POST") {
				return response(201, "", { Location: "/data/upload-token" });
			}
			if (options.method === "PATCH" && firstPatch) {
				firstPatch = false;
				throw new Error("Connection reset after upload");
			}
			if (options.method === "HEAD") return response(200, "", { "Upload-Offset": "3" });
			if (options.method === "PATCH") return response(204, "", { "Upload-Offset": "5" });
			if (options.method === "PROPFIND") return response(207, metadataXml("&quot;uploaded&quot;"));
			throw new Error(`Unexpected ${options.method} request`);
		});
		const connection = { ...bearerConnection, remotePath: "/", tusChunkSizeBytes: 3 };

		await new OpenCloudService().uploadFile(connection, "Folder/note.md", "hello", "text/plain");

		expect(requestUrlMock).toHaveBeenCalledWith(expect.objectContaining({
			method: "HEAD",
			url: "https://cloud.example.com/data/upload-token"
		}));
		const successfulPatch = requestUrlMock.mock.calls
			.filter(([options]) => options.method === "PATCH")
			.at(-1)?.[0];
		expect(successfulPatch?.headers?.["Upload-Offset"]).toBe("3");
	});

	it("rejects a stale conditional deletion before sending DELETE", async () => {
		requestUrlMock.mockResolvedValueOnce(response(207, metadataXml("&quot;new&quot;")));

		await expect(new OpenCloudService().deleteFile(
			bearerConnection,
			"Folder/note.md",
			{ ifMatch: "\"old\"" }
		)).rejects.toMatchObject({ status: 412 });

		expect(requestUrlMock.mock.calls.some(([options]) => options.method === "DELETE")).toBe(false);
	});
});
