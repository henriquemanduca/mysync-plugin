import { requestUrl } from "obsidian";
import PouchDB from "pouchdb/dist/pouchdb";
import type { VaultFileRecord } from "./types";
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

const logger = new Logger("PouchDbFileStore");
const VAULT_FILE_START_KEY = "vault-file:";
const VAULT_FILE_END_KEY = "vault-file:\ufff0";
const LOCAL_SYNC_BASELINE_LOCAL_DOC_ID = "_local/mysync-local-sync-baseline";
const REMOTE_BASELINE_LOCAL_DOC_PREFIX = "_local/mysync-remote-baseline:";

type OpenRevision<T extends { _id: string }> =
	| { ok: (T & PouchDB.ExistingDocument) | (PouchDB.ExistingDocument & { _deleted: true }) }
	| { missing: string };

type PouchDbOpenRevisions<T extends { _id: string }> = PouchDB.Database<T> & {
	get(id: string, options: { open_revs: "all" }): Promise<Array<OpenRevision<T>>>;
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

type BaselineDocument = LocalSyncBaselineDocument | RemoteBaselineDocument;

interface LocalDocumentStore {
	get(id: string): Promise<BaselineDocument & PouchDB.ExistingDocument>;
	put(doc: BaselineDocument): Promise<unknown>;
}

export class PouchDbFileStore {
	private fileDb: PouchDB<VaultFileRecord>;
	private fileDbClosed = false;
	private operationQueue = Promise.resolve();

	constructor(private localDatabaseName: string) {
		this.fileDb = new PouchDB<VaultFileRecord>(localDatabaseName);
	}

	async saveFileRecordIfChanged(record: VaultFileRecord) {
		return this.runWithLocalDb("saveFileRecordIfChanged", async (fileDb) => {
			try {
				const existing = await fileDb.get(record._id);

				if (existing.contentHash === record.contentHash) {
					logger.debug("File record unchanged", {
						recordId: record._id,
						path: record.path,
						fileType: record.fileType,
						size: record.size
					});
					return false;
				}

				await fileDb.put({
					...record,
					_rev: existing._rev
				});
				logger.debug("Changed file record updated", {
					recordId: record._id,
					path: record.path
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
					await fileDb.put(record);
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
		return this.runWithLocalDb("deleteFileRecordById", async (fileDb) => {
			try {
				const existing = await fileDb.get(recordId);
				await fileDb.remove(existing);
			} catch (error) {
				if (!isPouchNotFound(error)) {
					logger.error("Failed to remove deleted file record", error, { recordId });
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

		return this.runWithLocalDb("pushToCouchDb", async (fileDb) => {
			const remoteUrl = createRemoteDatabaseUrl(connection.url, connection.database);
			const options = createRemoteOptions(connection);

			if (pushOptions.pendingChangesOnly) {
				logger.info("Using PouchDB checkpoint for pending changes push", {
					database: connection.database
				});
			} else if (pushOptions.docIds) {
				options.doc_ids = Array.from(new Set(pushOptions.docIds)).filter(isSyncableFileRecordId);
			} else {
				logger.info("Listing syncable file records before push", {
					database: connection.database
				});

				options.doc_ids = await this.listSyncableFileRecordIdsFromDb(fileDb);
			}

			logger.info("Syncable file records listed for push", {
				database: connection.database,
				docIdsCount: options.doc_ids?.length ?? 0
			});

			let docsWritten = 0;

			return new Promise<RemotePushResult>((resolve, reject) => {
				logger.info("Starting PouchDB push replication", {
					database: connection.database,
					docIdsCount: options.doc_ids?.length ?? 0
				});

				fileDb.replicate
					.to(remoteUrl, options)
					.on("active", () => {
						logger.info("PouchDB push replication active", {
							database: connection.database,
							docsWritten
						});
					})
					.on("paused", () => {
						logger.info("PouchDB push replication paused", {
							database: connection.database,
							docsWritten
						});
					})
					.on("change", (change) => {
						docsWritten += change.docs_written ?? 0;
						logger.info("PouchDB push replication changed", {
							database: connection.database,
							changeDocsWritten: change.docs_written ?? 0,
							docsWritten
						});
						onProgress(docsWritten);
					})
					.on("denied", (error) => {
						logger.error("PouchDB push replication denied", error, {
							database: connection.database,
							docsWritten
						});
						reject(toError(error));
					})
					.on("error", (error) => {
						logger.error("PouchDB push replication failed", error, {
							database: connection.database,
							docsWritten
						});
						reject(toError(error));
					})
					.on("complete", (result) => {
						logger.info("PouchDB push replication completed", {
							database: connection.database,
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
		return this.runWithLocalDb("pullFromCouchDb", async (fileDb) => {
			const remoteUrl = createRemoteDatabaseUrl(connection.url, connection.database);
			const options = createRemoteOptions(connection);
			let docsRead = 0;

			return new Promise<RemotePullResult>((resolve, reject) => {
				fileDb.replicate
					.from(remoteUrl, options)
					.on("change", (change) => {
						docsRead += change.docs_read ?? 0;
						onProgress(docsRead);
					})
					.on("denied", (error) => {
						reject(toError(error));
					})
					.on("error", (error) => {
						reject(toError(error));
					})
					.on("complete", (result) => {
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
		return this.runWithLocalDb("hasRemoteBaseline", async (fileDb) => {
			const baselineId = await createRemoteBaselineLocalDocumentId(connection);

			try {
				await getLocalDocumentStore(fileDb).get(baselineId);
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

	async listFileRecords() {
		logger.debug("List file records requested");

		return this.runWithLocalDb("listFileRecords", async (fileDb) => {
			return this.listFileRecordsFromDb(fileDb);
		});
	}

	async listSyncableFileRecordIds() {
		logger.debug("List syncable file record ids requested");
		const records = await this.listFileRecords();
		const recordIds = records
			.map((record) => record._id)
			.filter(isSyncableFileRecordId);

		logger.debug("List syncable file record ids completed", {
			totalRecords: records.length,
			syncableRecords: recordIds.length
		});

		return recordIds;
	}

	private async listSyncableFileRecordIdsFromDb(fileDb: PouchDB<VaultFileRecord>) {
		logger.debug("List syncable file record ids from active database requested");
		const records = await this.listFileRecordsFromDb(fileDb);
		const recordIds = records
			.map((record) => record._id)
			.filter(isSyncableFileRecordId);

		logger.debug("List syncable file record ids from active database completed", {
			totalRecords: records.length,
			syncableRecords: recordIds.length
		});

		return recordIds;
	}

	private async listFileRecordsFromDb(fileDb: PouchDB<VaultFileRecord>) {
		const result = await fileDb.allDocs({
			include_docs: true,
			attachments: true,
			binary: true
		});

		return result.rows.flatMap(
			(row) => (row.doc ? [row.doc] : [])
		);
	}

	async listDeletedFileRecordIds(recordIds: string[]) {
		if (recordIds.length === 0) {
			return [];
		}

		return this.runWithLocalDb("listDeletedFileRecordIds", async (fileDb) => {
			const uniqueRecordIds = Array.from(new Set(recordIds));
			const deletedRecordIds = new Set<string>();

			await Promise.all(uniqueRecordIds.map(async (recordId) => {
				if (!recordId.startsWith("vault-file:")) {
					return;
				}

				try {
					const revisions = await (fileDb as PouchDbOpenRevisions<VaultFileRecord>)
						.get(recordId, { open_revs: "all" });

					for (const revision of revisions) {
						if ("ok" in revision && "_deleted" in revision.ok && revision.ok._deleted) {
							deletedRecordIds.add(recordId);
							return;
						}
					}
				} catch (error) {
					if (!isPouchNotFound(error)) {
						throw error;
					}
				}
			}));

			return Array.from(deletedRecordIds);
		});
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
		operation: (fileDb: PouchDB<VaultFileRecord>) => Promise<T>
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

async function createSha256Hex(value: string) {
	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(hashBuffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getLocalDocumentStore(fileDb: PouchDB<VaultFileRecord>) {
	return fileDb as unknown as LocalDocumentStore;
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
