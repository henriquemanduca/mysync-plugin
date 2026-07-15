import PouchDB from "pouchdb/dist/pouchdb";
import type { SyncConflict, SyncConflictStatus } from "./types";
import { isPouchNotFound } from "../utils/pouchdb-errors";
import { Logger } from "../utils/logger";

const logger = new Logger("PouchDbConflictStore");
const ACTIVE_CONFLICT_STATUSES = new Set<SyncConflictStatus>([
	"pending",
	"resolving",
	"pending-push",
	"stale",
	"error"
]);

export class PouchDbConflictStore {
	private conflictDb: PouchDB<SyncConflict>;
	private conflictDbClosed = false;
	private operationQueue = Promise.resolve();

	constructor(private localDatabaseName: string) {
		this.conflictDb = new PouchDB<SyncConflict>(localDatabaseName);
	}

	async ensureDatabaseExists() {
		await this.runWithLocalDb("ensureDatabaseExists", async (conflictDb) => {
			await conflictDb.info();
		});
	}

	async listConflicts() {
		return this.runWithLocalDb("listConflicts", async (conflictDb) => {
			const result = await conflictDb.allDocs({ include_docs: true });
			return result.rows
				.flatMap((row) => row.doc ? [row.doc] : [])
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		});
	}

	async listActiveConflicts() {
		return (await this.listConflicts()).filter((conflict) => ACTIVE_CONFLICT_STATUSES.has(conflict.status));
	}

	async getConflict(conflictId: string) {
		return this.runWithLocalDb("getConflict", async (conflictDb) => {
			try {
				return await conflictDb.get(conflictId);
			} catch (error) {
				if (isPouchNotFound(error)) {
					return null;
				}

				throw error;
			}
		});
	}

	async upsertConflict(conflict: Omit<SyncConflict, "_rev">) {
		return this.runWithLocalDb("upsertConflict", async (conflictDb) => {
			try {
				const existing = await conflictDb.get(conflict._id);
				await conflictDb.put({
					...conflict,
					detectedAt: existing.status === "resolved" ? conflict.detectedAt : existing.detectedAt,
					_rev: existing._rev
				});
			} catch (error) {
				if (isPouchNotFound(error)) {
					await conflictDb.put(conflict);
					return;
				}

				throw error;
			}
		});
	}

	async updateConflict(
		conflictId: string,
		update: (conflict: SyncConflict) => SyncConflict
	) {
		return this.runWithLocalDb("updateConflict", async (conflictDb) => {
			const existing = await conflictDb.get(conflictId);
			await conflictDb.put({
				...update(existing),
				_id: existing._id,
				_rev: existing._rev,
				updatedAt: new Date().toISOString()
			});
		});
	}

	async close() {
		const closeOperation = this.operationQueue.then(async () => {
			if (!this.conflictDbClosed) {
				await this.conflictDb.close();
				this.conflictDbClosed = true;
			}
		});

		this.operationQueue = closeOperation.then(
			() => undefined,
			() => undefined
		);

		await closeOperation;
	}

	private runWithLocalDb<T>(
		operationName: string,
		operation: (conflictDb: PouchDB<SyncConflict>) => Promise<T>
	) {
		const queuedOperation = this.operationQueue.then(async () => {
			this.ensureLocalDbOpen();

			try {
				return await operation(this.conflictDb);
			} catch (error) {
				logger.error(`Conflict store operation ${operationName} failed`, error);
				throw error;
			}
		});

		this.operationQueue = queuedOperation.then(
			() => undefined,
			() => undefined
		);

		return queuedOperation;
	}

	private ensureLocalDbOpen() {
		if (!this.conflictDbClosed) {
			return;
		}

		this.conflictDb = new PouchDB<SyncConflict>(this.localDatabaseName);
		this.conflictDbClosed = false;
	}
}
