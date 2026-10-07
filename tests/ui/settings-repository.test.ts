import { describe, expect, it } from "vitest";
import {
	createConflictDatabaseName,
	createLocalDatabaseName,
	createLocalVaultId,
	normalizeSavedSettings
} from "../../src/ui/settings/settings-repository";

describe("SettingsRepository helpers", () => {
	it("generates a vault ID string", () => {
		const vaultId = createLocalVaultId();
		expect(typeof vaultId).toBe("string");
		expect(vaultId.length).toBeGreaterThan(0);
	});

	it("creates standard database names", () => {
		const dbName = createLocalDatabaseName("test-id");
		expect(dbName).toBe("mysync-files-test-id");

		const conflictDbName = createConflictDatabaseName(dbName);
		expect(conflictDbName).toBe("mysync-conflicts-test-id");
	});

	it("normalizes and migrates legacy settings keys", () => {
		const legacyData = {
			lastPushToCouchDbAt: "2026-01-01T00:00:00Z",
			lastPullFromCouchDbAt: "2026-01-02T00:00:00Z",
			opencloudSpaceId: "storage%24space-id",
			syncFolderMode: "custom",
			customSyncFolder: "MyNotes",
			remoteBackend: "opencloud"
		};

		const normalized = normalizeSavedSettings(legacyData);

		expect(normalized.lastRemotePushAt).toBe("2026-01-01T00:00:00Z");
		expect(normalized.lastRemotePullAt).toBe("2026-01-02T00:00:00Z");
		expect(normalized.opencloudSpaceId).toBe("storage$space-id");
		expect(normalized.syncFolderMode).toBe("custom");
		expect(normalized.remoteBackend).toBe("opencloud");
	});
});

