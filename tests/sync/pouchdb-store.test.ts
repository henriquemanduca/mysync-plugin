import { beforeEach, describe, expect, it, vi } from "vitest";

const pouchState = vi.hoisted(() => ({
	db: {} as Record<string, unknown>
}));

vi.mock("pouchdb/dist/pouchdb", () => ({
	default: vi.fn(function PouchDbMock() {
		return pouchState.db;
	})
}));

import { PouchDbFileStore } from "../../src/sync/pouchdb-store";

function createDatabaseMock() {
	return {
		allDocs: vi.fn(),
		changes: vi.fn(),
		close: vi.fn().mockResolvedValue(undefined),
		destroy: vi.fn(),
		get: vi.fn(),
		info: vi.fn(),
		put: vi.fn(),
		remove: vi.fn(),
		replicate: {}
	};
}

describe("PouchDbFileStore Nextcloud changes", () => {
	beforeEach(() => {
		pouchState.db = createDatabaseMock();
	});

	it("returns live records and tombstones with their vault paths", async () => {
		const db = pouchState.db as ReturnType<typeof createDatabaseMock>;
		db.changes.mockResolvedValue({
			results: [{
				id: "vault-file:Area/current.md",
				seq: 4,
				changes: [{ rev: "2-live" }],
				doc: {
					_id: "vault-file:Area/current.md",
					_rev: "2-live",
					type: "vault-file",
					fileType: "markdown",
					fileName: "current.md",
					path: "Area/current.md",
					size: 5,
					contentHash: "hash",
					content: "hello",
					lastChanged: 100,
					lastChangedIso: new Date(100).toISOString()
				}
			}, {
				id: "vault-file:Area/deleted.md",
				seq: 5,
				changes: [{ rev: "3-delete" }],
				deleted: true,
				doc: {
					_id: "vault-file:Area/deleted.md",
					_rev: "3-delete",
					_deleted: true
				}
			}, {
				id: "_local/metadata",
				seq: 6,
				changes: [{ rev: "1-local" }]
			}],
			last_seq: 6
		});
		const store = new PouchDbFileStore("test-db");

		const result = await store.listFileChangesSince(3);

		expect(db.changes).toHaveBeenCalledWith({
			since: 3,
			style: "main_only",
			include_docs: true,
			attachments: true,
			binary: true
		});
		expect(result.lastSequence).toBe(6);
		expect(result.changes).toEqual([
			expect.objectContaining({
				recordId: "vault-file:Area/current.md",
				path: "Area/current.md",
				deleted: false
			}),
			{
				recordId: "vault-file:Area/deleted.md",
				path: "Area/deleted.md",
				deleted: true
			}
		]);
	});

	it("persists and reads a target-specific local checkpoint", async () => {
		const db = pouchState.db as ReturnType<typeof createDatabaseMock>;
		db.get.mockRejectedValueOnce({ status: 404 });
		db.put.mockResolvedValue({ ok: true });
		const store = new PouchDbFileStore("test-db");
		const targetKey = JSON.stringify({
			url: "https://cloud.example.com",
			username: "alice",
			remotePath: "Notes"
		});

		await store.saveNextcloudPushCheckpoint(targetKey, "8-g1AAA");

		expect(db.put).toHaveBeenCalledWith(expect.objectContaining({
			type: "mysync-nextcloud-push-checkpoint",
			targetKey,
			lastSequence: "8-g1AAA"
		}));
		const saved = db.put.mock.calls[0]?.[0];
		db.get.mockResolvedValue({ ...saved, _rev: "1-checkpoint" });
		await expect(store.getNextcloudPushCheckpoint(targetKey)).resolves.toBe("8-g1AAA");
		expect(String(saved._id)).toMatch(/^_local\/mysync-nextcloud-push:/);
	});

	it("persists a credential-free sync snapshot isolated by target key", async () => {
		const db = pouchState.db as ReturnType<typeof createDatabaseMock>;
		db.get.mockRejectedValueOnce({ status: 404 });
		db.put.mockResolvedValue({ ok: true });
		const store = new PouchDbFileStore("test-db");
		const targetKey = JSON.stringify({
			url: "https://cloud.example.com",
			username: "alice",
			remotePath: "Notes",
			syncFolder: "Projects",
			syncObsidianConfig: true
		});
		await store.saveNextcloudSyncState({
			type: "mysync-nextcloud-sync-state",
			targetKey,
			initializedAt: "2026-09-03T00:00:00.000Z",
			entries: {
				"Projects/a.md": {
					path: "Projects/a.md",
					etag: "\"one\"",
					size: 5,
					syncedContentHash: "hash"
				}
			}
		});

		const saved = db.put.mock.calls[0]?.[0];
		expect(saved).toMatchObject({ type: "mysync-nextcloud-sync-state", targetKey });
		expect(JSON.stringify(saved)).not.toContain("password");
		expect(String(saved._id)).toMatch(/^_local\/mysync-nextcloud-state:/);
		db.get.mockResolvedValue({ ...saved, _rev: "1-state" });
		await expect(store.getNextcloudSyncState(targetKey)).resolves.toMatchObject({
			entries: { "Projects/a.md": { etag: "\"one\"", syncedContentHash: "hash" } }
		});
	});
});
