import { requestUrl } from "obsidian";
import PouchDB from "pouchdb/dist/pouchdb";
import type { ConflictResolutionStrategy, VaultFileRecord } from "./types";
import { createFileRecordId, getPathFromFileRecordId, isSyncBlacklistedPath } from "./vault-files";
import { Logger } from "../utils/logger";
import { isPouchNotFound } from "../utils/pouchdb-errors";

export interface CouchDbConnection {
	url: string;
	database: string;
	username: string;
	password: string;
}

export interface RemotePushResult {
	docsWritten: number;
}

export interface RemotePullResult {
	docsRead: number;
}

export interface RemotePushOptions {
	docIds?: string[];
	pendingChangesOnly?: boolean;
}

export interface FileRevisionLeaf {
	revision: string;
	deleted: boolean;
	record?: VaultFileRecord & PouchDB.ExistingDocument;
}

export interface FileRevisionState {
	recordId: string;
	winningRevision?: string;
	leaves: FileRevisionLeaf[];
}

export type PouchDbSequence = string | number;

export type FileChange =
	| {
		recordId: string;
		path: string;
		deleted: true;
	}
	| {
		recordId: string;
		path: string;
		deleted: false;
		record: VaultFileRecord & PouchDB.ExistingDocument;
	};

export interface FileChangeBatch {
	changes: FileChange[];
	lastSequence: PouchDbSequence;
}

const logger = new Logger("PouchDbFileStore");
const VAULT_FILE_START_KEY = "vault-file:";
const VAULT_FILE_END_KEY = "vault-file:\ufff0";
const LOCAL_SYNC_BASELINE_LOCAL_DOC_ID = "_local/mysync-local-sync-baseline";
const REMOTE_BASELINE_LOCAL_DOC_PREFIX = "_local/mysync-remote-baseline:";
const NEXTCLOUD_PUSH_CHECKPOINT_LOCAL_DOC_PREFIX = "_local/mysync-nextcloud-push:";

type OpenRevision<T extends { _id: string }> =
	| { ok: (T & PouchDB.ExistingDocument) | (PouchDB.ExistingDocument & { _deleted: true }) }
	| { missing: string };

type PouchDbOpenRevisions<T extends { _id: string }> = {
	get(
		id: string,
		options: { open_revs: "all"; attachments?: boolean; binary?: boolean }
	): Promise<Array<OpenRevision<T>>>;
};

interface RemoteBaselineDocument {
	_id: string;
	_rev?: string;
	type: "mysync-remote-baseline";
	remoteKey: string;
	savedAt: string;
}

interface LocalSyncBaselineDocument {
	_id: string;
	_rev?: string;
	type: "mysync-local-sync-baseline";
	syncFolder: string;
	savedAt: string;
}

interface NextcloudPushCheckpointDocument {
	_id: string;
	_rev?: string;
	type: "mysync-nextcloud-push-checkpoint";
	targetKey: string;
	lastSequence: PouchDbSequence;
	savedAt: string;
}

type LocalMetadataDocument =
	| LocalSyncBaselineDocument
	| RemoteBaselineDocument
	| NextcloudPushCheckpointDocument;

interface LocalDocumentStore {
	get(id: string): Promise<LocalMetadataDocument & PouchDB.ExistingDocument>;
	put(doc: LocalMetadataDocument): Promise<unknown>;
}

export class PouchDbFileStore {
	private fileDb: PouchDB<VaultFileRecord>;
	private fileDbClosed = false;
	private operationQueue = Promise.resolve();

	constructor(private localDatabaseName: string) {
		this.fileDb = new PouchDB<VaultFileRecord>(localDatabaseName);
	}

	async saveFileRecordIfChanged(record: VaultFileRecord) {
		return this.runWithLocalDb("saveFileRecordIfChanged", async (locaDB) => {
			try {
				const existing = await locaDB.get(record._id);

				if (existing.contentHash === record.contentHash) {
					return false;
				}

				await locaDB.put({
					...(existing.conflictResolution
						? { conflictResolution: existing.conflictResolution }
						: {}),
					...record,
					_rev: existing._rev
				});
				return true;
			} catch (error) {
				if (isPouchNotFound(error)) {
					logger.debug("Creating new file record", {
						recordId: record._id,
						path: record.path,
						fileType: record.fileType,
						size: record.size
					});
					await locaDB.put(record);
					logger.debug("New file record created", {
						recordId: record._id,
						path: record.path
					});
					return true;
				}

				throw error;
			}
		});
	}

	async deleteFileRecordByPath(path: string) {
		await this.deleteFileRecordById(createFileRecordId(path));
	}

	async deleteFileRecordById(recordId: string) {
		return this.runWithLocalDb("deleteFileRecordById", async (localDB) => {
			try {
				const existing = await localDB.get(recordId);
				await localDB.remove(existing);
			} catch (error) {
				if (!isPouchNotFound(error)) {
					logger.error("Failed to remove deleted file record", error, { recordId });
				}
			}
		});
	}

	async deleteFileRecordsByPathPrefix(folderPath: string, excludedPaths?: Set<string>) {
		return this.runWithLocalDb("deleteFileRecordsByPathPrefix", async (fileDb) => {
			const prefix = `${folderPath.replace(/\/+$/g, "")}/`;
			const startkey = createFileRecordId(prefix);
			const endkey = createFileRecordId(`${prefix}\ufff0`);

			const result = await fileDb.allDocs({
				startkey,
				endkey,
				include_docs: true
			});

			for (const row of result.rows) {
				if (row.doc && isSyncableFileRecordId(row.id) && (!excludedPaths || !excludedPaths.has(row.doc.path))) {
					await fileDb.remove(row.doc);
				}
			}
		});
	}

	async pushToCouchDb(
		connection: CouchDbConnection,
		onProgress: (docsWritten: number) => void,
		pushOptions: RemotePushOptions = {}
	) {
		logger.info("Push to CouchDB requested", {
			database: connection.database,
			hasUsername: connection.username.length > 0,
			hasPassword: connection.password.length > 0
		});

		return this.runWithLocalDb("pushToCouchDb", async (localDB) => {
			const remoteUrl = createRemoteDatabaseUrl(connection.url, connection.database);
			const options = createRemoteOptions(connection);

			if (pushOptions.pendingChangesOnly) {
				logger.info("Using PouchDB checkpoint for pending changes push");

			} else if (pushOptions.docIds) {
				options.doc_ids = Array.from(new Set(pushOptions.docIds)).filter(isSyncableFileRecordId);

			} else {
				logger.info("Listing syncable file records before push");
				options.doc_ids = await this.listSyncableFileRecordIdsFromDb(localDB);
			}

			logger.info("Syncable file records listed for push", {
				database: connection.database,
				docIdsCount: options.doc_ids?.length ?? 0
			});

			let docsWritten = 0;

			return new Promise<RemotePushResult>((resolve, reject) => {
				logger.info("Starting PouchDB push replication", {
					docIdsCount: options.doc_ids?.length ?? 0
				});

				localDB.replicate
					.to(remoteUrl, options)
					// .on("active", () => {
					// 	logger.info("PouchDB push replication active", { docsWritten });
					// })
					// .on("paused", () => {
					// 	logger.info("PouchDB push replication paused", { docsWritten });
					// })
					.on("change", (change) => {
						// docsWritten += change.docs_written ?? 0;
						const changedDocs = change.docs ?? [];

						if (typeof change.docs_written === "number") {
							docsWritten = change.docs_written;
						} else {
							docsWritten += changedDocs.length;
						}

						for (const document of changedDocs) {
							const path = document.path ?? getPathFromFileRecordId(document._id);
							const fileName = document.fileName
								?? path?.slice(path.lastIndexOf("/") + 1)
								?? document._id;

							logger.debug("PouchDB file revision pushed", {
								fileName,
								path,
								revision: document._rev,
								deleted: document._deleted === true
							});
						}

						logger.info("PouchDB push replication changed", {
							batchDocsWritten: change.docs_written ?? 0,
							docsWritten
						});

						onProgress(docsWritten);
					})
					.on("denied", (error) => {
						logger.error("PouchDB push replication denied", error, { docsWritten });
						reject(toError(error));
					})
					.on("error", (error) => {
						logger.error("PouchDB push replication failed", error, { docsWritten });
						reject(toError(error));
					})
					.on("complete", (result) => {
						logger.info("PouchDB push replication completed", {
							resultDocsWritten: result.docs_written,
							docsWritten
						});
						resolve({
							docsWritten: result.docs_written ?? docsWritten
						});
					});
			});
		});
	}

	async canPushToCouchDb(connection: CouchDbConnection) {
		const [remoteHasFileRecords, hasLocalBaseline] = await Promise.all([
			this.hasRemoteFileRecords(connection),
			this.hasRemoteBaseline(connection)
		]);

		return !remoteHasFileRecords || hasLocalBaseline;
	}

	async pullFromCouchDb(connection: CouchDbConnection, onProgress: (docsRead: number) => void) {
		return this.runWithLocalDb("pullFromCouchDb", async (localDB) => {
			const remoteUrl = createRemoteDatabaseUrl(connection.url, connection.database);
			const options = createRemoteOptions(connection);
			let docsRead = 0;

			return new Promise<RemotePullResult>((resolve, reject) => {
				localDB.replicate
					.from(remoteUrl, options)
					.on("change", (change) => {
						const changedDocs = change.docs ?? [];

						if (typeof change.docs_read === "number") {
							docsRead = change.docs_read;
						} else {
							docsRead += changedDocs.length;
						}

						for (const document of changedDocs) {
							const path = document.path ?? getPathFromFileRecordId(document._id);
							const fileName = document.fileName
								?? path?.slice(path.lastIndexOf("/") + 1)
								?? document._id;

							logger.debug("PouchDB file revision pulled", {
								fileName,
								path,
								revision: document._rev,
								deleted: document._deleted === true
							});
						}

						logger.info("PouchDB pull replication changed", {
							batchDocsRead: change.docs_read ?? 0,
							docsRead
						});

						onProgress(docsRead);
					})
					.on("denied", (error) => {
						logger.error("PouchDB pull replication denied", error, { docsRead });
						reject(toError(error));
					})
					.on("error", (error) => {
						logger.error("PouchDB pull replication failed", error, { docsRead });
						reject(toError(error));
					})
					.on("complete", (result) => {
						logger.info("PouchDB pull replication completed", {
							resultDocsRead: result.docs_written,
							docsRead
						});
						resolve({
							docsRead: result.docs_read ?? docsRead
						});
					});
			});
		});
	}

	async hasRemoteFileRecords(connection: CouchDbConnection) {
		const remoteUrl = createRemoteDatabaseUrl(connection.url, connection.database);
		const remoteDb = new PouchDB<VaultFileRecord>(remoteUrl, createRemoteOptions(connection));

		try {
			const result = await remoteDb.allDocs({
				startkey: VAULT_FILE_START_KEY,
				endkey: VAULT_FILE_END_KEY
			});

			return result.rows.some((row) => isSyncableFileRecordId(row.id));
		} finally {
			await remoteDb.close();
		}
	}

	async hasRemoteBaseline(connection: CouchDbConnection) {
		return this.runWithLocalDb("hasRemoteBaseline", async (localDB) => {
			const baselineId = await createRemoteBaselineLocalDocumentId(connection);

			try {
				await getLocalDocumentStore(localDB).get(baselineId);
				return true;
			} catch (error) {
				if (isPouchNotFound(error)) {
					return false;
				}

				throw error;
			}
		});
	}

	async hasLocalSyncBaseline(syncFolder: string) {
		return this.runWithLocalDb("hasLocalSyncBaseline", async (fileDb) => {
			try {
				const baseline = await getLocalDocumentStore(fileDb).get(LOCAL_SYNC_BASELINE_LOCAL_DOC_ID);
				return baseline.type === "mysync-local-sync-baseline"
					&& baseline.syncFolder === syncFolder;
			} catch (error) {
				if (isPouchNotFound(error)) {
					return false;
				}

				throw error;
			}
		});
	}

	async markLocalSyncBaseline(syncFolder: string) {
		return this.runWithLocalDb("markLocalSyncBaseline", async (fileDb) => {
			const localDocs = getLocalDocumentStore(fileDb);
			const baseline: LocalSyncBaselineDocument = {
				_id: LOCAL_SYNC_BASELINE_LOCAL_DOC_ID,
				type: "mysync-local-sync-baseline",
				syncFolder,
				savedAt: new Date().toISOString()
			};

			try {
				const existing = await localDocs.get(LOCAL_SYNC_BASELINE_LOCAL_DOC_ID);
				await localDocs.put({
					...baseline,
					_rev: existing._rev
				});
			} catch (error) {
				if (isPouchNotFound(error)) {
					await localDocs.put(baseline);
					return;
				}

				throw error;
			}
		});
	}

	async markRemoteBaseline(connection: CouchDbConnection) {
		return this.runWithLocalDb("markRemoteBaseline", async (fileDb) => {
			const baselineId = await createRemoteBaselineLocalDocumentId(connection);
			const remoteKey = createRemoteKey(connection);
			const localDocs = getLocalDocumentStore(fileDb);
			const baseline: RemoteBaselineDocument = {
				_id: baselineId,
				type: "mysync-remote-baseline",
				remoteKey,
				savedAt: new Date().toISOString()
			};

			try {
				const existing = await localDocs.get(baselineId);
				await localDocs.put({
					...baseline,
					_rev: existing._rev
				});
			} catch (error) {
				if (isPouchNotFound(error)) {
					await localDocs.put(baseline);
					return;
				}

				throw error;
			}
		});
	}

	async listFileRecords(options: { attachments?: boolean } = { attachments: true }) {
		logger.debug("Local file list records requested");
		return this.runWithLocalDb("listFileRecords", async (fileDb) => {
			return this.listFileRecordsFromDb(fileDb, options);
		});
	}

	async listFileChangesSince(since: PouchDbSequence): Promise<FileChangeBatch> {
		return this.runWithLocalDb("listFileChangesSince", async (fileDb) => {
			const result = await fileDb.changes({
				since,
				style: "main_only",
				include_docs: true,
				attachments: true,
				binary: true
			});
			const changes = result.results.flatMap((change): FileChange[] => {
				if (!isSyncableFileRecordId(change.id)) {
					return [];
				}

				const path = getPathFromFileRecordId(change.id);

				if (!path) {
					return [];
				}

				if (change.deleted || change.doc?._deleted) {
					return [{
						recordId: change.id,
						path,
						deleted: true
					}];
				}

				if (!change.doc) {
					return [];
				}

				return [{
					recordId: change.id,
					path,
					deleted: false,
					record: change.doc as VaultFileRecord & PouchDB.ExistingDocument
				}];
			});

			return {
				changes,
				lastSequence: result.last_seq
			};
		});
	}

	async getNextcloudPushCheckpoint(targetKey: string): Promise<PouchDbSequence | null> {
		return this.runWithLocalDb("getNextcloudPushCheckpoint", async (fileDb) => {
			const checkpointId = await createNextcloudPushCheckpointLocalDocumentId(targetKey);

			try {
				const checkpoint = await getLocalDocumentStore(fileDb).get(checkpointId);
				return checkpoint.type === "mysync-nextcloud-push-checkpoint"
					? checkpoint.lastSequence
					: null;
			} catch (error) {
				if (isPouchNotFound(error)) {
					return null;
				}

				throw error;
			}
		});
	}

	async saveNextcloudPushCheckpoint(
		targetKey: string,
		lastSequence: PouchDbSequence
	) {
		return this.runWithLocalDb("saveNextcloudPushCheckpoint", async (fileDb) => {
			const checkpointId = await createNextcloudPushCheckpointLocalDocumentId(targetKey);
			const localDocs = getLocalDocumentStore(fileDb);
			const checkpoint: NextcloudPushCheckpointDocument = {
				_id: checkpointId,
				type: "mysync-nextcloud-push-checkpoint",
				targetKey,
				lastSequence,
				savedAt: new Date().toISOString()
			};

			try {
				const existing = await localDocs.get(checkpointId);
				await localDocs.put({
					...checkpoint,
					_rev: existing._rev
				});
			} catch (error) {
				if (isPouchNotFound(error)) {
					await localDocs.put(checkpoint);
					return;
				}

				throw error;
			}
		});
	}

	async listAllFileRecordIds() {
		return this.runWithLocalDb("listAllFileRecordIds", async (fileDb) => {
			const changes = await fileDb.changes({
				since: 0,
				style: "all_docs"
			});

			return Array.from(new Set(
				changes.results
					.map((change) => change.id)
					.filter(isSyncableFileRecordId)
			));
		});
	}

	async listFileRevisionStates(recordIds: string[]) {
		return this.runWithLocalDb("listFileRevisionStates", async (fileDb) => {
			return Promise.all(Array.from(new Set(recordIds)).map(
				(recordId) => this.getFileRevisionStateFromDb(fileDb, recordId)
			));
		});
	}

	async getFileRevision(recordId: string, revision: string) {
		return this.runWithLocalDb("getFileRevision", async (fileDb) => {
			const document = await fileDb.get(recordId, {
				rev: revision,
				attachments: true,
				binary: true
			}) as (VaultFileRecord & PouchDB.ExistingDocument & { _deleted?: boolean });

			return document._deleted ? null : document;
		});
	}

	async getFileRecordWithAttachments(recordId: string) {
		return this.runWithLocalDb("getFileRecordWithAttachments", async (fileDb) => {
			try {
				return await fileDb.get(recordId, { attachments: true, binary: true }) as VaultFileRecord & PouchDB.ExistingDocument;
			} catch (error) {
				if (isPouchNotFound(error)) {
					return null;
				}
				throw error;
			}
		});
	}

	async resolveFileRecordWithContent(
		recordId: string,
		sourceRecord: VaultFileRecord & { _rev?: string; _deleted?: boolean },
		resolvedBy: string,
		strategy: ConflictResolutionStrategy
	) {
		return this.runWithLocalDb("resolveFileRecordWithContent", async (fileDb) => {
			const state = await this.getFileRevisionStateFromDb(fileDb, recordId);
			const winningRevision = state.winningRevision;

			if (!winningRevision) {
				throw new Error(`Cannot resolve ${recordId}: winning revision not found.`);
			}

			const { _rev: ignoredRevision, _deleted: ignoredDeletion, ...recordBody } = sourceRecord;
			void ignoredRevision;
			void ignoredDeletion;

			await fileDb.put({
				...recordBody,
				_id: recordId,
				_rev: winningRevision,
				conflictResolution: undefined
			});

			for (const leaf of state.leaves) {
				if (!leaf.deleted && leaf.revision !== winningRevision) {
					await fileDb.remove({
						_id: recordId,
						_rev: leaf.revision
					});
				}
			}

			const prunedState = await this.getFileRevisionStateFromDb(fileDb, recordId);
			const acknowledgedDeletedLeafRevisions = prunedState.leaves
				.filter((leaf) => leaf.deleted)
				.map((leaf) => leaf.revision)
				.sort();
			const canonical = await fileDb.get(recordId);

			await fileDb.put({
				...canonical,
				conflictResolution: {
					acknowledgedDeletedLeafRevisions,
					resolvedAt: new Date().toISOString(),
					resolvedBy,
					strategy
				}
			});
		});
	}

	async resolveFileRecordAsDeleted(recordId: string) {
		return this.runWithLocalDb("resolveFileRecordAsDeleted", async (fileDb) => {
			const state = await this.getFileRevisionStateFromDb(fileDb, recordId);

			for (const leaf of state.leaves) {
				if (!leaf.deleted) {
					await fileDb.remove({
						_id: recordId,
						_rev: leaf.revision
					});
				}
			}
		});
	}

	private async listSyncableFileRecordIdsFromDb(fileDb: PouchDB<VaultFileRecord>) {
		logger.debug("List syncable file record ids from active database requested");
		const records = await this.listFileRecordsFromDb(fileDb, { attachments: false });
		const recordIds = records
			.map((record) => record._id)
			.filter(isSyncableFileRecordId);

		logger.debug("List syncable file record ids from active database completed", {
			totalRecords: records.length,
			syncableRecords: recordIds.length
		});

		return recordIds;
	}

	private async listFileRecordsFromDb(
		fileDb: PouchDB<VaultFileRecord>,
		options: { attachments?: boolean } = { attachments: true }
	) {
		const result = await fileDb.allDocs({
			include_docs: true,
			attachments: options.attachments,
			binary: options.attachments
		});

		return result.rows.flatMap(
			(row) => (row.doc && isSyncableFileRecordId(row.id) ? [row.doc] : [])
		);
	}

	private async getFileRevisionStateFromDb(
		fileDb: PouchDB<VaultFileRecord>,
		recordId: string
	): Promise<FileRevisionState> {
		if (!isSyncableFileRecordId(recordId)) {
			return { recordId, leaves: [] };
		}

		const [allDocs, revisions] = await Promise.all([
			fileDb.allDocs({ keys: [recordId] }),
			(fileDb as PouchDbOpenRevisions<VaultFileRecord>).get(recordId, {
				open_revs: "all"
			}).catch((error: unknown) => {
				if (isPouchNotFound(error)) {
					return [] as Array<OpenRevision<VaultFileRecord>>;
				}

				throw error;
			})
		]);

		const winningRevision = allDocs.rows[0]?.value?.rev;
		const leaves = revisions.flatMap((revision): FileRevisionLeaf[] => {
			if (!("ok" in revision)) {
				return [];
			}

			const document = revision.ok as VaultFileRecord & PouchDB.ExistingDocument & { _deleted?: boolean };

			if (document._deleted) {
				return [{
					revision: document._rev,
					deleted: true
				}];
			}

			return [{
				revision: document._rev,
				deleted: false,
				record: document
			}];
		});

		return {
			recordId,
			winningRevision,
			leaves
		};
	}

	async testCouchDbConnection(connection: CouchDbConnection) {
		const remoteUrl = createRemoteDatabaseUrl(connection.url, connection.database);
		const remoteDb = new PouchDB<VaultFileRecord>(remoteUrl, createRemoteOptions(connection));

		try {
			const info = await remoteDb.info();

			if (isDatabaseInfoError(info)) {
				throw new Error(formatDatabaseInfoError(info));
			}

			return {
				databaseName: info.db_name,
				documentCount: info.doc_count
			};
		} finally {
			await remoteDb.close();
		}
	}

	async reset() {
		const resetOperation = this.operationQueue.then(async () => {
			this.ensureLocalDbOpen();
			logger.warn("Resetting local file database", undefined, {
				database: this.localDatabaseName
			});

			try {
				await this.fileDb.destroy();
			} finally {
				this.fileDbClosed = true;
				this.ensureLocalDbOpen();
			}

			await this.fileDb.info();
			logger.info("Local file database reset completed", {
				database: this.localDatabaseName
			});
		});

		this.operationQueue = resetOperation.then(
			() => undefined,
			() => undefined
		);

		await resetOperation;
	}

	async close() {
		const closeOperation = this.operationQueue.then(async () => {
			if (!this.fileDbClosed) {
				await this.fileDb.close();
				this.fileDbClosed = true;
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
		operation: (localDB: PouchDB<VaultFileRecord>) => Promise<T>
	) {
		const queuedOperation = this.operationQueue.then(async () => {
			this.ensureLocalDbOpen();
			try {
				return await operation(this.fileDb);
			} catch (error) {
				logger.error(`operation from ${operationName} fail`, error);
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
		if (!this.fileDbClosed) {
			return;
		}

		this.fileDb = new PouchDB<VaultFileRecord>(this.localDatabaseName);
		this.fileDbClosed = false;
	}
}

function createRemoteDatabaseUrl(url: string, database: string) {
	return `${url.replace(/\/+$/g, "")}/${encodeURIComponent(database)}`;
}

function isSyncableFileRecordId(recordId: string) {
	const path = getPathFromFileRecordId(recordId);
	return typeof path === "string" && !isSyncBlacklistedPath(path);
}

function createRemoteKey(connection: CouchDbConnection) {
	return `${connection.url.replace(/\/+$/g, "")}/${connection.database}`;
}

async function createRemoteBaselineLocalDocumentId(connection: CouchDbConnection) {
	return `${REMOTE_BASELINE_LOCAL_DOC_PREFIX}${await createSha256Hex(createRemoteKey(connection))}`;
}

async function createNextcloudPushCheckpointLocalDocumentId(targetKey: string) {
	return `${NEXTCLOUD_PUSH_CHECKPOINT_LOCAL_DOC_PREFIX}${await createSha256Hex(targetKey)}`;
}

async function createSha256Hex(value: string) {
	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(hashBuffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getLocalDocumentStore(localDB: PouchDB<VaultFileRecord>) {
	return localDB as unknown as LocalDocumentStore;
}

function createRemoteOptions(connection: CouchDbConnection): PouchDB.ReplicationOptions {
	const options: PouchDB.ReplicationOptions = {
		skip_setup: true,
		fetch: createObsidianFetch()
	};

	if (connection.username || connection.password) {
		options.auth = {
			username: connection.username,
			password: connection.password
		};
	}

	return options;
}

function isDatabaseInfoError(info: PouchDB.DatabaseInfo): info is PouchDB.DatabaseInfo & { error: string } {
	return typeof info.error === "string" && info.error.length > 0;
}

function toError(reason: unknown): Error {
	if (reason instanceof Error) {
		return reason;
	}

	if (typeof reason === "string") {
		return new Error(reason);
	}

	return new Error(`PouchDB replication failed: ${JSON.stringify(reason)}`);
}

function formatDatabaseInfoError(info: PouchDB.DatabaseInfo & { error: string }) {
	if (info.reason) {
		return `CouchDB connection failed: ${info.error}. ${info.reason}`;
	}

	return `CouchDB connection failed: ${info.error}.`;
}

function createObsidianFetch() {
	return async function obsidianFetch(
		url: RequestInfo | URL,
		init: RequestInit = {}
	): Promise<Response> {
		const method = (init.method ?? "GET").toUpperCase();
		const headers = normalizeHeaders(init.headers);
		const body = await normalizeRequestBody(init.body);

		const requestUrlString = url.toString();

		const result = await requestUrl({
			url: requestUrlString,
			method,
			headers,
			body,
			throw: false
		});

		return new Response(result.arrayBuffer, {
			status: result.status,
			headers: result.headers
		});
	};
}

function normalizeHeaders(headersInit?: HeadersInit): Record<string, string> {
	const headers: Record<string, string> = {};

	if (!headersInit) {
		return headers;
	}

	new Headers(headersInit).forEach((value, key) => {
		headers[key] = value;
	});

	return headers;
}

async function normalizeRequestBody(body: BodyInit | null | undefined): Promise<string | ArrayBuffer | undefined> {
	if (body == null) {
		return undefined;
	}

	if (typeof body === "string" || body instanceof ArrayBuffer) {
		return body;
	}

	if (body instanceof Blob) {
		return body.arrayBuffer();
	}

	if (body instanceof URLSearchParams) {
		return body.toString();
	}

	if (ArrayBuffer.isView(body)) {
		const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
		return new Uint8Array(bytes).buffer;
	}

	throw new Error("Unsupported request body type for Obsidian requestUrl");
}
