import type { MySyncSettings } from "../../core/types/settings.types";
import type { CouchDbConnection } from "../../sync/pouchdb-store";

export function validateCouchDbSettings(settings: MySyncSettings, operation = "pushing"): string | null {
	if (!settings.couchDbUrl) {
		return `Set a CouchDB URL before ${operation}.`;
	}

	if (!isHttpUrl(settings.couchDbUrl)) {
		return `Set a valid CouchDB URL before ${operation}.`;
	}

	if (!settings.couchDbDatabase) {
		return `Set a CouchDB database before ${operation}.`;
	}

	return null;
}

export function createCouchDbConnection(settings: MySyncSettings): CouchDbConnection {
	return {
		url: settings.couchDbUrl,
		database: settings.couchDbDatabase,
		username: settings.couchDbUsername,
		password: settings.couchDbPassword
	};
}

export function getPendingPushBlockingState(
	hasLocalSyncBaseline: boolean,
	hasRemoteBaseline: boolean
): { statusMessage: string; noticeMessage: string } | null {
	if (!hasLocalSyncBaseline && !hasRemoteBaseline) {
		return {
			statusMessage: "Local and remote baselines required",
			noticeMessage: "Run a full local sync and establish the remote baseline with a full push or pull before pushing pending changes."
		};
	}

	if (!hasLocalSyncBaseline) {
		return {
			statusMessage: "Full local sync required",
			noticeMessage: "Run Sync now before pushing pending changes."
		};
	}

	if (!hasRemoteBaseline) {
		return {
			statusMessage: "Remote baseline required",
			noticeMessage: "Run a full push or pull before pushing pending changes."
		};
	}

	return null;
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

