import type { TFile } from "obsidian";
import PouchDB from "pouchdb";
import type { VaultFileRecord } from "sync/types";
import { createFileRecordId } from "sync/vault-files";
import { Logger } from 'utils/logger';
import { isPouchConflict, isPouchNotFound } from "utils/pouchdb-errors";

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

const logger = new Logger("PouchDbFileStore");

export class PouchDbFileStore {
	private fileDb: PouchDB<VaultFileRecord>;
	private fileDbClosed = false;
	private operationQueue = Promise.resolve();

	constructor(private localDatabaseName: string) {
		this.fileDb = new PouchDB<VaultFileRecord>(localDatabaseName);
	}

	async hasFileChanged(file: TFile) {
		return this.runWithLocalDb(async (fileDb) => {
			try {
				const existing = await fileDb.get(createFileRecordId(file.path));
				return existing.lastChanged !== file.stat.mtime;
			} catch (error) {
				if (isPouchNotFound(error)) {
					return true;
				}

				throw error;
			}
		});
	}

	async saveFileRecord(record: VaultFileRecord) {
		return this.runWithLocalDb(async (fileDb) => {
			try {
				await fileDb.put(record);
			} catch (error) {
				if (!isPouchConflict(error)) {
					throw error;
				}

				const existing = await fileDb.get(record._id);
				await fileDb.put({
					...record,
					_rev: existing._rev
				});
			}
		});
	}

	async deleteFileRecordByPath(path: string) {
		return this.runWithLocalDb(async (fileDb) => {
			try {
				const existing = await fileDb.get(createFileRecordId(path));
				await fileDb.remove(existing);
			} catch (error) {
				if (!isPouchNotFound(error)) {
					logger.error("Failed to remove deleted file record", error, { path });
				}
			}
		});
	}

	async pushToCouchDb(connection: CouchDbConnection, onProgress: (docsWritten: number) => void) {
		return this.runWithLocalDb(async (fileDb) => {
			const remoteUrl = createRemoteDatabaseUrl(connection.url, connection.database);
			const options = createRemoteOptions(connection);
			let docsWritten = 0;

			return new Promise<RemotePushResult>((resolve, reject) => {
				fileDb.replicate
					.to(remoteUrl, options)
					.on("change", (change) => {
						docsWritten += change.docs_written ?? 0;
						onProgress(docsWritten);
					})
					.on("denied", (error) => {
						reject(error);
					})
					.on("error", (error) => {
						reject(error);
					})
					.on("complete", (result) => {
						resolve({
							docsWritten: result.docs_written ?? docsWritten
						});
					});
			});
		});
	}

	async pullFromCouchDb(connection: CouchDbConnection, onProgress: (docsRead: number) => void) {
		return this.runWithLocalDb(async (fileDb) => {
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
						reject(error);
					})
					.on("error", (error) => {
						reject(error);
					})
					.on("complete", (result) => {
						resolve({
							docsRead: result.docs_read ?? docsRead
						});
					});
			});
		});
	}

	async listFileRecords() {
		return this.runWithLocalDb(async (fileDb) => {
			const result = await fileDb.allDocs({
				include_docs: true,
				attachments: true,
				binary: true
			});

			return result.rows.flatMap((row) => (row.doc ? [row.doc] : []));
		});
	}

	async listDeletedFileRecordIds(recordIds: string[]) {
		if (recordIds.length === 0) {
			return [];
		}

		return this.runWithLocalDb(async (fileDb) => {
			const result = await fileDb.allDocs({
				keys: Array.from(new Set(recordIds))
			});

			return result.rows.flatMap((row) => {
				if (row.value?.deleted && row.id.startsWith("vault-file:")) {
					return [row.id];
				}

				return [];
			});
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

	private runWithLocalDb<T>(operation: (fileDb: PouchDB<VaultFileRecord>) => Promise<T>) {
		const queuedOperation = this.operationQueue.then(async () => {
			this.ensureLocalDbOpen();
			return operation(this.fileDb);
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

function createRemoteOptions(connection: CouchDbConnection): PouchDB.ReplicationOptions {
	if (!connection.username && !connection.password) {
		return {
			skip_setup: true
		};
	}

	return {
		skip_setup: true,
		auth: {
			username: connection.username,
			password: connection.password
		}
	};
}

function isDatabaseInfoError(info: PouchDB.DatabaseInfo): info is PouchDB.DatabaseInfo & { error: string } {
	return typeof info.error === "string" && info.error.length > 0;
}

function formatDatabaseInfoError(info: PouchDB.DatabaseInfo & { error: string }) {
	if (info.reason) {
		return `CouchDB connection failed: ${info.error}. ${info.reason}`;
	}

	return `CouchDB connection failed: ${info.error}.`;
}
