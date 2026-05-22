declare module "pouchdb" {
	namespace PouchDB {
		interface ExistingDocument {
			_id: string;
			_rev: string;
		}

		interface AuthOptions {
			username: string;
			password: string;
		}

		interface ReplicationOptions {
			auth?: AuthOptions;
			live?: boolean;
			retry?: boolean;
			skip_setup?: boolean;
		}

		interface ReplicationChange {
			docs_written?: number;
			docs_read?: number;
		}

		interface ReplicationResult {
			docs_written?: number;
			docs_read?: number;
			ok?: boolean;
		}

		interface ReplicationEventEmitter {
			on(event: "change", listener: (change: ReplicationChange) => void): ReplicationEventEmitter;
			on(event: "complete", listener: (result: ReplicationResult) => void): ReplicationEventEmitter;
			on(event: "error", listener: (error: unknown) => void): ReplicationEventEmitter;
			on(event: "denied", listener: (error: unknown) => void): ReplicationEventEmitter;
			on(event: "active" | "paused", listener: () => void): ReplicationEventEmitter;
		}

		interface ReplicationMethods<T extends { _id: string }> {
			to(remote: string | Database<T>, options?: ReplicationOptions): ReplicationEventEmitter;
			from(remote: string | Database<T>, options?: ReplicationOptions): ReplicationEventEmitter;
		}

		interface AllDocsOptions {
			include_docs?: boolean;
			attachments?: boolean;
			binary?: boolean;
			keys?: string[];
		}

		interface AllDocsRow<T extends { _id: string }> {
			id: string;
			key: string;
			value: {
				rev: string;
				deleted?: boolean;
			};
			doc?: T & ExistingDocument;
		}

		interface AllDocsResponse<T extends { _id: string }> {
			total_rows: number;
			offset: number;
			rows: Array<AllDocsRow<T>>;
		}

		interface DatabaseInfo {
			db_name: string;
			doc_count?: number;
			update_seq?: string | number;
			host?: string;
			error?: string;
			reason?: string;
		}

		interface Database<T extends { _id: string }> {
			replicate: ReplicationMethods<T>;
			put(doc: T | (T & { _rev: string })): Promise<unknown>;
			get(id: string): Promise<T & ExistingDocument>;
			remove(doc: ExistingDocument): Promise<unknown>;
			allDocs(options?: AllDocsOptions): Promise<AllDocsResponse<T>>;
			info(): Promise<DatabaseInfo>;
			close(): Promise<void>;
			destroy(): Promise<unknown>;
		}
	}

	class PouchDB<T extends { _id: string }> {
		constructor(name: string);
		constructor(name: string, options?: { auth?: PouchDB.AuthOptions });
		replicate: PouchDB.ReplicationMethods<T>;
		put(doc: T | (T & { _rev: string })): Promise<unknown>;
		get(id: string): Promise<T & PouchDB.ExistingDocument>;
		remove(doc: PouchDB.ExistingDocument): Promise<unknown>;
		allDocs(options?: PouchDB.AllDocsOptions): Promise<PouchDB.AllDocsResponse<T>>;
		info(): Promise<PouchDB.DatabaseInfo>;
		close(): Promise<void>;
		destroy(): Promise<unknown>;
	}

	export default PouchDB;
}
