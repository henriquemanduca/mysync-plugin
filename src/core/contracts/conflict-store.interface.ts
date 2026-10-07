import type { SyncConflict } from "../types/conflict.types";

export interface IConflictStore {
	ensureDatabaseExists(): Promise<void>;
	listConflicts(): Promise<SyncConflict[]>;
	listActiveConflicts(): Promise<SyncConflict[]>;
	getConflict(conflictId: string): Promise<SyncConflict | null>;
	upsertConflict(conflict: SyncConflict): Promise<void>;
	updateConflict(
		conflictId: string,
		update: (conflict: SyncConflict) => SyncConflict
	): Promise<void>;
	reset(): Promise<void>;
	close(): void;
}

