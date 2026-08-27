import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MySyncSettings } from "../../src/settings";
import type { PouchDbConflictStore } from "../../src/sync/conflict-store";
import type { PouchDbFileStore } from "../../src/sync/pouchdb-store";
import { SyncService, type SyncStatus } from "../../src/sync/sync-service";
import type { VaultFileRecord } from "../../src/sync/types";
import { Logger } from "../../src/utils/logger";
import { Notice, TAbstractFile, TFile, TFolder } from "../mocks/obsidian";

function arrayBuffer(value: string) {
	return new TextEncoder().encode(value).buffer;
}

function configRecord(path: string): VaultFileRecord {
	return {
		_id: `vault-file:${path}`,
		type: "vault-file",
		source: "obsidian-config",
		fileType: "binary",
		fileName: path.slice(path.lastIndexOf("/") + 1),
		path,
		mimeType: "application/octet-stream",
		size: 2,
		contentHash: "hash",
		_attachments: {
			file: {
				content_type: "application/octet-stream",
				data: new Blob([arrayBuffer("{}")])
			}
		},
		lastChanged: 100,
		lastChangedIso: new Date(100).toISOString()
	};
}

function createFixture(configDir = ".obsidian") {
	const root = new TFolder("/");
	const adapter = {
		list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
		readBinary: vi.fn(),
		stat: vi.fn(),
		trashLocal: vi.fn(),
		trashSystem: vi.fn().mockResolvedValue(true),
		writeBinary: vi.fn().mockResolvedValue(undefined)
	};
	const vault = {
		adapter,
		cachedRead: vi.fn(),
		configDir,
		getAbstractFileByPath: vi.fn().mockReturnValue(null),
		getRoot: vi.fn().mockReturnValue(root)
	};
	const fileManager = {
		trashFile: vi.fn()
	};
	const app = {
		fileManager,
		vault
	} as unknown as App;
	const store = {
		deleteFileRecordById: vi.fn().mockResolvedValue(undefined),
		listAllFileRecordIds: vi.fn().mockResolvedValue([]),
		listFileRecords: vi.fn().mockResolvedValue([]),
		listFileRevisionStates: vi.fn().mockResolvedValue([]),
		markLocalSyncBaseline: vi.fn().mockResolvedValue(undefined),
		markRemoteBaseline: vi.fn().mockResolvedValue(undefined),
		pullFromCouchDb: vi.fn().mockResolvedValue({ docsRead: 0 }),
		resolveFileRecordAsDeleted: vi.fn().mockResolvedValue(undefined),
		saveFileRecordIfChanged: vi.fn().mockResolvedValue(true)
	};
	const conflictStore = {
		ensureDatabaseExists: vi.fn().mockResolvedValue(undefined),
		listActiveConflicts: vi.fn().mockResolvedValue([]),
		updateConflict: vi.fn().mockResolvedValue(undefined),
		upsertConflict: vi.fn().mockResolvedValue(undefined)
	};
	const settings: MySyncSettings = {
		localVaultId: "local",
		localConflictDatabase: "mysync-conflicts-local",
		syncFolderMode: "vault-root",
		customSyncFolder: "",
		couchDbUrl: "",
		couchDbDatabase: "mysync",
		couchDbUsername: "",
		couchDbPassword: "",
		logLevel: "off",
		lastSyncNowAt: "",
		lastPushToCouchDbAt: "",
		lastPullFromCouchDbAt: "",
		lastLocalDatabaseResetAt: ""
	};
	const statuses: SyncStatus[] = [];
	const onOperationCompleted = vi.fn().mockResolvedValue(undefined);
	const service = new SyncService(
		app,
		store as unknown as PouchDbFileStore,
		conflictStore as unknown as PouchDbConflictStore,
		() => settings,
		(status) => statuses.push(status),
		onOperationCompleted,
		vi.fn()
	);

	return {
		adapter,
		conflictStore,
		fileManager,
		onOperationCompleted,
		root,
		service,
		settings,
		statuses,
		store,
		vault
	};
}

function markdownRecord(path: string, content = "hello"): VaultFileRecord {
	return {
		_id: `vault-file:${path}`,
		type: "vault-file",
		fileType: "markdown",
		fileName: path.slice(path.lastIndexOf("/") + 1),
		path,
		size: content.length,
		contentHash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		content,
		lastChanged: 100,
		lastChangedIso: new Date(100).toISOString()
	};
}

function configureVaultTree(
	fixture: ReturnType<typeof createFixture>,
	root: TFolder
) {
	const filesByPath = new Map<string, TAbstractFile>();
	const addFolder = (folder: TFolder) => {
		filesByPath.set(folder.path, folder);

		for (const child of folder.children) {
			filesByPath.set(child.path, child);

			if (child instanceof TFolder) {
				addFolder(child);
			}
		}
	};

	addFolder(root);
	fixture.vault.getRoot.mockReturnValue(root);
	fixture.vault.getAbstractFileByPath.mockImplementation((path: string) => filesByPath.get(path) ?? null);
	fixture.fileManager.trashFile.mockImplementation(async (file: TAbstractFile) => {
		file.parent?.children.splice(file.parent.children.indexOf(file), 1);
		filesByPath.delete(file.path);
	});
}

function deleteRemoteFile(
	fixture: ReturnType<typeof createFixture>,
	record: VaultFileRecord,
	localRecord: VaultFileRecord | null = record
) {
	return (fixture.service as unknown as {
		deleteRemoteDeletedFile(
			recordId: string,
			localRecordsById: Map<string, VaultFileRecord>
		): Promise<string>;
	}).deleteRemoteDeletedFile(
		record._id,
		localRecord ? new Map([[record._id, localRecord]]) : new Map()
	);
}

describe("SyncService configuration synchronization", () => {
	beforeEach(() => {
		Logger.setLevel("off");
	});

	afterEach(() => {
		Logger.setLevel("debug");
	});

	it("backs up only selected Obsidian configuration files during sync now", async () => {
		const fixture = createFixture();
		const content = arrayBuffer("{\"theme\":\"moonstone\"}");
		fixture.adapter.list.mockResolvedValue({
			files: [
				".obsidian/app.json",
				".obsidian/appearance.json",
				".obsidian/hotkeys.json",
				".obsidian/workspace.json"
			],
			folders: [".obsidian/plugins"]
		});
		fixture.adapter.stat.mockResolvedValue({
			type: "file",
			ctime: 100,
			mtime: 200,
			size: content.byteLength
		});
		fixture.adapter.readBinary.mockResolvedValue(content);

		await fixture.service.syncNow();

		expect(fixture.store.saveFileRecordIfChanged).toHaveBeenCalledTimes(3);
		expect(fixture.store.saveFileRecordIfChanged).toHaveBeenCalledWith(
			expect.objectContaining({ path: ".obsidian/app.json" })
		);
		expect(fixture.store.saveFileRecordIfChanged).toHaveBeenCalledWith(
			expect.objectContaining({ path: ".obsidian/hotkeys.json" })
		);
		expect(fixture.store.saveFileRecordIfChanged).toHaveBeenCalledWith(
			expect.objectContaining({ path: ".obsidian/workspace.json" })
		);
		expect(fixture.store.saveFileRecordIfChanged).not.toHaveBeenCalledWith(
			expect.objectContaining({ path: ".obsidian/appearance.json" })
		);
		expect(fixture.store.markLocalSyncBaseline).toHaveBeenCalledWith("/");
		expect(fixture.onOperationCompleted).toHaveBeenCalledWith("syncNow");
		expect(fixture.statuses.at(-1)).toEqual({
			state: "done",
			total: 3,
			saved: 3,
			skipped: 0
		});
	});

	it("counts unchanged configuration files as skipped", async () => {
		const fixture = createFixture();
		const content = arrayBuffer("{}");
		fixture.adapter.list.mockResolvedValue({
			files: [".obsidian/app.json"],
			folders: []
		});
		fixture.adapter.stat.mockResolvedValue({
			type: "file",
			ctime: 100,
			mtime: 200,
			size: content.byteLength
		});
		fixture.adapter.readBinary.mockResolvedValue(content);
		fixture.store.saveFileRecordIfChanged.mockResolvedValue(false);

		await fixture.service.syncNow();

		expect(fixture.statuses.at(-1)).toEqual({
			state: "done",
			total: 1,
			saved: 0,
			skipped: 1
		});
	});

	it("creates a deletion revision for a removed configuration file", async () => {
		const fixture = createFixture();
		fixture.store.listFileRecords.mockResolvedValue([
			configRecord(".obsidian/hotkeys.json")
		]);

		await fixture.service.syncNow();

		expect(fixture.store.deleteFileRecordById)
			.toHaveBeenCalledWith("vault-file:.obsidian/hotkeys.json");
		expect(fixture.statuses.at(-1)).toEqual({
			state: "done",
			total: 1,
			saved: 1,
			skipped: 0
		});
	});

	it("reports an error and does not complete when the adapter fails", async () => {
		const fixture = createFixture();
		fixture.adapter.list.mockRejectedValue(new Error("Configuration unavailable"));

		await fixture.service.syncNow();

		expect(fixture.onOperationCompleted).not.toHaveBeenCalled();
		expect(fixture.statuses.at(-1)).toEqual({
			state: "error",
			message: "synchronization failed"
		});
		expect(Notice.instances.at(-1)?.message).toBe("Configuration unavailable");
	});

	it("restores a pulled configuration file through the adapter", async () => {
		const fixture = createFixture();
		const remoteRecord = configRecord(".obsidian/app.json");
		fixture.settings.couchDbUrl = "https://couchdb.example.com";
		fixture.store.listFileRecords
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([remoteRecord]);
		fixture.store.listAllFileRecordIds
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([remoteRecord._id]);
		fixture.store.listFileRevisionStates
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{
				recordId: remoteRecord._id,
				winningRevision: "1-remote",
				leaves: [{
					revision: "1-remote",
					deleted: false,
					record: {
						...remoteRecord,
						_rev: "1-remote"
					}
				}]
			}]);
		fixture.store.pullFromCouchDb.mockResolvedValue({ docsRead: 1 });
		fixture.adapter.stat.mockResolvedValue(null);

		await fixture.service.pullFromCouchDb();

		expect(fixture.adapter.writeBinary).toHaveBeenCalledWith(
			".obsidian/app.json",
			expect.any(ArrayBuffer)
		);
		expect(fixture.store.markRemoteBaseline).toHaveBeenCalledOnce();
		expect(fixture.onOperationCompleted).toHaveBeenCalledWith("pullFromCouchDb");
		expect(Notice.instances.at(-1)?.message)
			.toContain("Reload Obsidian to apply configuration changes.");
	});

	it("cleans up a pulled configuration file outside the allowlist without restoring or conflicting", async () => {
		const fixture = createFixture(".configuration");
		const remoteRecord = configRecord(".configuration/appearance.json");
		fixture.settings.couchDbUrl = "https://couchdb.example.com";
		fixture.adapter.list.mockResolvedValue({
			files: [remoteRecord.path],
			folders: []
		});
		fixture.store.listFileRecords
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([remoteRecord]);
		fixture.store.listAllFileRecordIds
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([remoteRecord._id]);
		fixture.store.listFileRevisionStates
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{
				recordId: remoteRecord._id,
				winningRevision: "2-remote",
				leaves: [{
					revision: "1-local-delete",
					deleted: true
				}, {
					revision: "2-remote",
					deleted: false,
					record: {
						...remoteRecord,
						_rev: "2-remote"
					}
				}]
			}]);
		fixture.store.pullFromCouchDb.mockResolvedValue({ docsRead: 1 });

		await fixture.service.pullFromCouchDb();

		expect(fixture.store.listFileRevisionStates).toHaveBeenNthCalledWith(1, []);
		expect(fixture.store.resolveFileRecordAsDeleted)
			.toHaveBeenCalledWith(remoteRecord._id);
		expect(fixture.adapter.writeBinary).not.toHaveBeenCalled();
		expect(fixture.conflictStore.upsertConflict).not.toHaveBeenCalled();
		expect(fixture.statuses.at(-1)).toEqual({
			state: "pulled",
			docsRead: 1,
			restored: 0,
			deleted: 0,
			skipped: 1,
			conflicts: 0
		});
	});

	it("resolves an existing conflict for configuration outside the allowlist during initialization", async () => {
		const fixture = createFixture();
		const conflict = {
			_id: "mysync-conflict:vault-file:.obsidian/appearance.json",
			recordId: "vault-file:.obsidian/appearance.json",
			path: ".obsidian/appearance.json",
			kind: "local-delete-remote-edit" as const,
			status: "pending" as const,
			detectedAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			observedLeafRevisions: ["1-local", "1-remote"],
			localVariant: { exists: false },
			remoteVariants: []
		};
		fixture.conflictStore.listActiveConflicts.mockResolvedValue([conflict]);

		await fixture.service.initialize();

		expect(fixture.store.resolveFileRecordAsDeleted)
			.toHaveBeenCalledWith(conflict.recordId);
		expect(fixture.conflictStore.updateConflict)
			.toHaveBeenCalledWith(conflict._id, expect.any(Function));
		const updateConflict = fixture.conflictStore.updateConflict.mock.calls[0]?.[1];
		expect(updateConflict?.(conflict)).toMatchObject({
			status: "resolved",
			resolution: {
				strategy: "delete",
				resolvedDocumentIds: [conflict.recordId]
			}
		});
		await expect(fixture.service.listActiveConflicts()).resolves.toEqual([]);
	});

	it("does not restore a configuration record into a nested plugin directory", async () => {
		const fixture = createFixture();
		const remoteRecord = {
			...configRecord(".obsidian/plugins/example/data.json"),
			source: "obsidian-config" as const
		};
		fixture.settings.couchDbUrl = "https://couchdb.example.com";
		fixture.store.listFileRecords
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([remoteRecord]);
		fixture.store.listAllFileRecordIds
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([remoteRecord._id]);
		fixture.store.listFileRevisionStates
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{
				recordId: remoteRecord._id,
				winningRevision: "1-remote",
				leaves: [{
					revision: "1-remote",
					deleted: false,
					record: {
						...remoteRecord,
						_rev: "1-remote"
					}
				}]
			}]);
		fixture.store.pullFromCouchDb.mockResolvedValue({ docsRead: 1 });

		await fixture.service.pullFromCouchDb();

		expect(fixture.adapter.writeBinary).not.toHaveBeenCalled();
	});
});

describe("SyncService remote deletion cleanup", () => {
	beforeEach(() => {
		Logger.setLevel("off");
	});

	afterEach(() => {
		Logger.setLevel("debug");
	});

	it("removes empty ancestors without removing the custom sync folder", async () => {
		const fixture = createFixture();
		const file = new TFile("Sync/Topic/note.md", 5);
		const topic = new TFolder("Sync/Topic", [file]);
		const syncFolder = new TFolder("Sync", [topic]);
		const root = new TFolder("/", [syncFolder]);
		const record = markdownRecord(file.path);
		fixture.settings.syncFolderMode = "custom";
		fixture.settings.customSyncFolder = "Sync";
		fixture.vault.cachedRead.mockResolvedValue("hello");
		configureVaultTree(fixture, root);

		await expect(deleteRemoteFile(fixture, record)).resolves.toBe("deleted");

		expect(fixture.fileManager.trashFile).toHaveBeenNthCalledWith(1, file);
		expect(fixture.fileManager.trashFile).toHaveBeenNthCalledWith(2, topic);
		expect(fixture.fileManager.trashFile).toHaveBeenCalledTimes(2);
		expect(syncFolder.children).toEqual([]);
		expect(root.children).toEqual([syncFolder]);
	});

	it("keeps an ancestor that still has content", async () => {
		const fixture = createFixture();
		const file = new TFile("Topic/note.md", 5);
		const retainedFile = new TFile("Topic/keep.md", 4);
		const topic = new TFolder("Topic", [file, retainedFile]);
		const root = new TFolder("/", [topic]);
		const record = markdownRecord(file.path);
		fixture.vault.cachedRead.mockResolvedValue("hello");
		configureVaultTree(fixture, root);

		await expect(deleteRemoteFile(fixture, record)).resolves.toBe("deleted");

		expect(fixture.fileManager.trashFile).toHaveBeenCalledTimes(1);
		expect(fixture.fileManager.trashFile).toHaveBeenCalledWith(file);
		expect(root.children).toEqual([topic]);
		expect(topic.children).toEqual([retainedFile]);
	});

	it("never removes the vault root while pruning an empty chain", async () => {
		const fixture = createFixture();
		const file = new TFile("Area/Topic/note.md", 5);
		const topic = new TFolder("Area/Topic", [file]);
		const area = new TFolder("Area", [topic]);
		const root = new TFolder("/", [area]);
		const record = markdownRecord(file.path);
		fixture.vault.cachedRead.mockResolvedValue("hello");
		configureVaultTree(fixture, root);

		await expect(deleteRemoteFile(fixture, record)).resolves.toBe("deleted");

		expect(fixture.fileManager.trashFile).toHaveBeenNthCalledWith(1, file);
		expect(fixture.fileManager.trashFile).toHaveBeenNthCalledWith(2, topic);
		expect(fixture.fileManager.trashFile).toHaveBeenNthCalledWith(3, area);
		expect(fixture.fileManager.trashFile).toHaveBeenCalledTimes(3);
		expect(root.children).toEqual([]);
	});

	it("does not prune the Obsidian configuration folder", async () => {
		const fixture = createFixture();
		const record = configRecord(".obsidian/app.json");
		fixture.adapter.stat.mockResolvedValue({ type: "file" });

		await expect(deleteRemoteFile(fixture, record, null)).resolves.toBe("deleted");

		expect(fixture.adapter.trashSystem).toHaveBeenCalledWith(record.path);
		expect(fixture.fileManager.trashFile).not.toHaveBeenCalled();
	});
});

describe("SyncService empty vault folder cleanup", () => {
	beforeEach(() => {
		Logger.setLevel("off");
	});

	afterEach(() => {
		Logger.setLevel("debug");
	});

	it("removes empty folder trees throughout the vault while preserving configuration folders", async () => {
		const fixture = createFixture();
		const topic = new TFolder("Area/Topic");
		const area = new TFolder("Area", [topic]);
		const retainedFile = new TFile("Notes/keep.md", 4);
		const notes = new TFolder("Notes", [retainedFile]);
		const pluginFolder = new TFolder(".obsidian/plugins");
		const configFolder = new TFolder(".obsidian", [pluginFolder]);
		const root = new TFolder("/", [area, notes, configFolder]);
		configureVaultTree(fixture, root);

		expect(fixture.service.getEmptyVaultFolderCount()).toBe(2);
		await expect(fixture.service.cleanEmptyVaultFolders()).resolves.toEqual({
			total: 2,
			removed: 2,
			skipped: 0
		});

		expect(fixture.fileManager.trashFile).toHaveBeenNthCalledWith(1, topic);
		expect(fixture.fileManager.trashFile).toHaveBeenNthCalledWith(2, area);
		expect(root.children).toEqual([notes, configFolder]);
		expect(configFolder.children).toEqual([pluginFolder]);
		expect(fixture.statuses.at(-1)).toEqual({
			state: "empty-folders-cleaned",
			removed: 2,
			skipped: 0
		});
	});

	it("skips a folder that gains content after the cleanup scan", async () => {
		const fixture = createFixture();
		const topic = new TFolder("Area/Topic");
		const area = new TFolder("Area", [topic]);
		const root = new TFolder("/", [area]);
		configureVaultTree(fixture, root);
		fixture.fileManager.trashFile.mockImplementation(async (folder: TAbstractFile) => {
			folder.parent?.children.splice(folder.parent.children.indexOf(folder), 1);

			if (folder === topic) {
				area.children.push(new TFile("Area/created-during-cleanup.md", 1));
			}
		});

		await expect(fixture.service.cleanEmptyVaultFolders()).resolves.toEqual({
			total: 2,
			removed: 1,
			skipped: 1
		});

		expect(fixture.fileManager.trashFile).toHaveBeenCalledTimes(1);
		expect(root.children).toEqual([area]);
	});

	it("continues when moving an empty folder to trash fails", async () => {
		const fixture = createFixture();
		const topic = new TFolder("Area/Topic");
		const area = new TFolder("Area", [topic]);
		const root = new TFolder("/", [area]);
		configureVaultTree(fixture, root);
		fixture.fileManager.trashFile.mockRejectedValue(new Error("Trash unavailable"));

		await expect(fixture.service.cleanEmptyVaultFolders()).resolves.toEqual({
			total: 2,
			removed: 0,
			skipped: 2
		});

		expect(fixture.fileManager.trashFile).toHaveBeenCalledTimes(1);
		expect(root.children).toEqual([area]);
	});
});
