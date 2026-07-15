declare module "pouchdb" {
	namespace PouchDB {
		interface ExistingDocument {
			_id: string;
			_rev: string;
		}

		interface PutResponse {
			ok: boolean;
			id: string;
			rev: string;
		}

		interface AuthOptions {
			username: string;
			password: string;
		}

		interface ReplicationOptions {
			auth?: AuthOptions;
			doc_ids?: string[];
			live?: boolean;
			retry?: boolean;
			fetch?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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
			startkey?: string;
			endkey?: string;
			limit?: number;
		}

		interface AllDocsRow<T extends { _id: string }> {
			id: string;
			key: string;
			value?: {
				rev: string;
				deleted?: boolean;
			};
			error?: string;
			reason?: string;
			doc?: T & ExistingDocument;
		}

		interface AllDocsResponse<T extends { _id: string }> {
			total_rows: number;
			offset: number;
			rows: Array<AllDocsRow<T>>;
		}

		interface ChangesOptions {
			since?: string | number;
			style?: "all_docs" | "main_only";
			include_docs?: boolean;
		}

		interface ChangesResult {
			id: string;
			changes: Array<{ rev: string }>;
			deleted?: boolean;
		}

		interface ChangesResponse {
			results: ChangesResult[];
			last_seq: string | number;
			pending?: number;
		}

		interface GetOptions {
			rev?: string;
			open_revs?: "all" | string[];
			attachments?: boolean;
			binary?: boolean;
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
			put(doc: T | (T & { _rev: string })): Promise<PutResponse>;
			get(id: string): Promise<T & ExistingDocument>;
			get(id: string, options: GetOptions): Promise<unknown>;
			remove(doc: ExistingDocument): Promise<unknown>;
			allDocs(options?: AllDocsOptions): Promise<AllDocsResponse<T>>;
			changes(options?: ChangesOptions): Promise<ChangesResponse>;
			info(): Promise<DatabaseInfo>;
			close(): Promise<void>;
			destroy(): Promise<unknown>;
		}
	}

	class PouchDB<T extends { _id: string }> {
		constructor(name: string);
		constructor(name: string, options?: { auth?: PouchDB.AuthOptions });
		replicate: PouchDB.ReplicationMethods<T>;
		put(doc: T | (T & { _rev: string })): Promise<PouchDB.PutResponse>;
		get(id: string): Promise<T & PouchDB.ExistingDocument>;
		get(id: string, options: PouchDB.GetOptions): Promise<unknown>;
		remove(doc: PouchDB.ExistingDocument): Promise<unknown>;
		allDocs(options?: PouchDB.AllDocsOptions): Promise<PouchDB.AllDocsResponse<T>>;
		changes(options?: PouchDB.ChangesOptions): Promise<PouchDB.ChangesResponse>;
		info(): Promise<PouchDB.DatabaseInfo>;
		close(): Promise<void>;
		destroy(): Promise<unknown>;
	}

	export default PouchDB;
}

declare module "pouchdb/dist/pouchdb" {
	import PouchDB from "pouchdb";
	export default PouchDB;
}
