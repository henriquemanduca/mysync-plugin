import type { VaultFileRecord } from "../types/file.types";

export interface IFileStore {
	saveFileRecordIfChanged(record: VaultFileRecord): Promise<boolean>;
	deleteFileRecord(recordId: string, options?: { expectedContentHash?: string }): Promise<boolean>;
	getFileRecord(recordId: string): Promise<VaultFileRecord | null>;
	listFileRecords(): Promise<VaultFileRecord[]>;
	reset(): Promise<void>;
	close(): void;
}

