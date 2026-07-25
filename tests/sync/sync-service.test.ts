import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MySyncSettings } from "../../src/settings";
import type { PouchDbConflictStore } from "../../src/sync/conflict-store";
import type { PouchDbFileStore } from "../../src/sync/pouchdb-store";
import { SyncService, type SyncStatus } from "../../src/sync/sync-service";
import type { VaultFileRecord } from "../../src/sync/types";
import { Logger } from "../../src/utils/logger";
import { Notice, TFolder } from "../mocks/obsidian";

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
		writeBinary: vi.fn().mockResolvedValue(undefined)
	};
	const vault = {
		adapter,
		configDir,
		getAbstractFileByPath: vi.fn().mockReturnValue(null),
		getRoot: vi.fn().mockReturnValue(root)
	};
	const app = {
		fileManager: {
			trashFile: vi.fn()
		},
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
		onOperationCompleted,
		service,
		settings,
		statuses,
		store
	};
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
