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

function createFixture() {
	const root = new TFolder("/");
	const adapter = {
		list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
		readBinary: vi.fn(),
		stat: vi.fn(),
		writeBinary: vi.fn().mockResolvedValue(undefined)
	};
	const vault = {
		adapter,
		configDir: ".obsidian",
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
		saveFileRecordIfChanged: vi.fn().mockResolvedValue(true)
	};
	const conflictStore = {
		listActiveConflicts: vi.fn().mockResolvedValue([])
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

	it("backs up top-level Obsidian configuration during sync now", async () => {
		const fixture = createFixture();
		const content = arrayBuffer("{\"theme\":\"moonstone\"}");
		fixture.adapter.list.mockResolvedValue({
			files: [".obsidian/appearance.json"],
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

		expect(fixture.store.saveFileRecordIfChanged).toHaveBeenCalledOnce();
		expect(fixture.store.saveFileRecordIfChanged).toHaveBeenCalledWith(
			expect.objectContaining({
				_id: "vault-file:.obsidian/appearance.json",
				source: "obsidian-config",
				path: ".obsidian/appearance.json"
			})
		);
		expect(fixture.store.markLocalSyncBaseline).toHaveBeenCalledWith("/");
		expect(fixture.onOperationCompleted).toHaveBeenCalledWith("syncNow");
		expect(fixture.statuses.at(-1)).toEqual({
			state: "done",
			total: 1,
			saved: 1,
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
