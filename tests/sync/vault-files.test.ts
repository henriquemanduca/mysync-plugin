import type { App, TFile, TFolder } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { TFile as MockTFile, TFolder as MockTFolder } from "../mocks/obsidian";
import {
	collectFilesInFolder,
	createBinaryContentHash,
	createFileRecord,
	createFileRecordId,
	createObsidianConfigFileRecord,
	createTextContentHash,
	getPathFromFileRecordId,
	isObsidianConfigFilePath,
	isPathInsideSyncFolder,
	listObsidianConfigFilePaths,
	normalizeTextContent
} from "../../src/sync/vault-files";

function arrayBuffer(value: string) {
	return new TextEncoder().encode(value).buffer;
}

function createApp(configDir = ".obsidian") {
	const adapter = {
		list: vi.fn(),
		readBinary: vi.fn(),
		stat: vi.fn()
	};
	const vault = {
		adapter,
		cachedRead: vi.fn(),
		configDir,
		readBinary: vi.fn()
	};

	return {
		app: { vault } as unknown as App,
		adapter,
		vault
	};
}

describe("vault file paths", () => {
	it("creates and parses stable record IDs", () => {
		const id = createFileRecordId("Notes/example.md");

		expect(id).toBe("vault-file:Notes/example.md");
		expect(getPathFromFileRecordId(id)).toBe("Notes/example.md");
		expect(getPathFromFileRecordId("other:Notes/example.md")).toBeNull();
	});

	it("checks paths against root and custom sync folders", () => {
		expect(isPathInsideSyncFolder("Notes/example.md", "/")).toBe(true);
		expect(isPathInsideSyncFolder("Projects/MySync/note.md", "Projects/MySync")).toBe(true);
		expect(isPathInsideSyncFolder("Projects/Other/note.md", "Projects/MySync")).toBe(false);
	});

	it("collects files recursively", () => {
		const first = new MockTFile("first.md");
		const second = new MockTFile("Nested/second.md");
		const nested = new MockTFolder("Nested", [second]);
		const root = new MockTFolder("/", [first, nested]);

		expect(collectFilesInFolder(root as unknown as TFolder))
			.toEqual([first, second]);
	});
});

describe("file content records", () => {
	it("normalizes line endings before hashing text", async () => {
		expect(normalizeTextContent("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
		expect(await createTextContentHash("one\r\ntwo"))
			.toBe(await createTextContentHash("one\ntwo"));
	});

	it("generates different hashes for different binary content", async () => {
		expect(await createBinaryContentHash(arrayBuffer("first")))
			.not.toBe(await createBinaryContentHash(arrayBuffer("second")));
	});

	it("creates a Markdown record from the Vault API", async () => {
		const { app, vault } = createApp();
		const file = new MockTFile("Notes/example.md", 7, 1_721_835_000_000);
		vault.cachedRead.mockResolvedValue("content");

		const record = await createFileRecord(app, file as unknown as TFile);

		expect(record).toMatchObject({
			_id: "vault-file:Notes/example.md",
			fileName: "example.md",
			fileType: "markdown",
			path: "Notes/example.md",
			content: "content",
			size: 7
		});
	});
});

describe("Obsidian configuration files", () => {
	it("uses the configured directory instead of hardcoding .obsidian", () => {
		const { app } = createApp(".configuration");

		expect(isObsidianConfigFilePath(app, ".configuration/app.json")).toBe(true);
		expect(isObsidianConfigFilePath(app, ".obsidian/app.json")).toBe(false);
	});

	it("accepts only top-level files from the configuration directory", async () => {
		const { app, adapter } = createApp(".configuration");
		adapter.list.mockResolvedValue({
			files: [
				".configuration/workspace.json",
				".configuration/plugins/example/data.json",
				".configuration/app.json"
			],
			folders: [".configuration/plugins"]
		});

		await expect(listObsidianConfigFilePaths(app)).resolves.toEqual([
			".configuration/app.json",
			".configuration/workspace.json"
		]);
	});

	it("creates a binary record with the configuration contents", async () => {
		const { app, adapter } = createApp();
		const content = arrayBuffer("{\"theme\":\"moonstone\"}");
		adapter.stat.mockResolvedValue({
			type: "file",
			ctime: 100,
			mtime: 200,
			size: content.byteLength
		});
		adapter.readBinary.mockResolvedValue(content);

		const record = await createObsidianConfigFileRecord(app, ".obsidian/appearance.json");

		expect(record).toMatchObject({
			_id: "vault-file:.obsidian/appearance.json",
			source: "obsidian-config",
			fileName: "appearance.json",
			fileType: "binary",
			mimeType: "application/octet-stream",
			size: content.byteLength,
			lastChanged: 200
		});
		expect(record._attachments?.file?.data).toBeInstanceOf(Blob);
	});

	it("rejects nested configuration files", async () => {
		const { app } = createApp();

		await expect(createObsidianConfigFileRecord(
			app,
			".obsidian/plugins/example/data.json"
		)).rejects.toThrow("not a top-level Obsidian configuration file");
	});
});
