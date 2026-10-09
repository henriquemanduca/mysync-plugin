import { IDLE_STATUS_DELAY_MS, type MySyncSettings, type SyncStatus } from "../../core";
import { formatDateTime } from "../../utils/date-format";

interface SyncStatusView {
	text: string;
	title: string;
	returnToIdle?: boolean;
}

export class StatusBarController {
	private idleStatusTimer: number | null = null;
	private activeConflictCount = 0;
	private currentSyncStatus: SyncStatus = { state: "idle" };

	constructor(
		private readonly statusBarEl: HTMLElement,
		private readonly getSettings: () => MySyncSettings,
		private readonly onConflictClick: () => void
	) {
		this.statusBarEl.addEventListener("click", () => this.onConflictClick());
		this.render();
	}

	updateSyncStatus(status: SyncStatus): void {
		this.currentSyncStatus = status;
		this.clearIdleStatusTimer();
		const view = this.render();

		if (view.returnToIdle) {
			this.scheduleIdleStatus();
		}
	}

	updateConflictCount(count: number): void {
		this.activeConflictCount = count;
		this.render();
	}

	getCurrentStatus(): SyncStatus {
		return this.currentSyncStatus;
	}

	destroy(): void {
		this.clearIdleStatusTimer();
	}

	private render(): SyncStatusView {
		this.statusBarEl.empty();
		this.statusBarEl.addClass("mysync-status");

		const view = createSyncStatusView(this.currentSyncStatus, this.getSettings());
		const conflictSuffix = this.activeConflictCount > 0
			? ` · ${this.activeConflictCount} conflict${this.activeConflictCount === 1 ? "" : "s"}`
			: "";

		this.statusBarEl.setText(`${view.text}${conflictSuffix}`);
		this.statusBarEl.title = `${view.title}${conflictSuffix}`;
		this.statusBarEl.toggleClass("mysync-status-has-conflicts", this.activeConflictCount > 0);

		return view;
	}

	private scheduleIdleStatus(): void {
		this.idleStatusTimer = window.setTimeout(() => {
			this.idleStatusTimer = null;
			this.updateSyncStatus({ state: "idle" });
		}, IDLE_STATUS_DELAY_MS);
	}

	private clearIdleStatusTimer(): void {
		if (this.idleStatusTimer !== null) {
			window.clearTimeout(this.idleStatusTimer);
			this.idleStatusTimer = null;
		}
	}
}

export function createSyncStatusView(status: SyncStatus, settings: MySyncSettings): SyncStatusView {
	switch (status.state) {
		case "idle": {
			const lastPushAt = formatDateTime(settings.lastRemotePushAt, { includeTime: true });
			return {
				text: lastPushAt ? lastPushAt : "...",
				title: "MySync last push"
			};
		}

		case "queued":
			return {
				text: `queued ${status.pending}`,
				title: `${status.pending} file(s) queued for sync`
			};

		case "syncing": {
			const percent = calculatePercent(status.current, status.total);
			return {
				text: `preparing ${percent}%`,
				title: `Saved ${status.saved}`
			};
		}

		case "done": {
			const text = `Saved ${status.saved}`;
			return {
				text,
				title: text,
				returnToIdle: true
			};
		}

		case "pushing": {
			if (typeof status.totalDocs === "number" && status.totalDocs > 0) {
				const percent = calculatePercent(status.docsWritten, status.totalDocs);
				return {
					text: `pushing ${percent}%`,
					title: `Processing remote operations (${status.docsWritten}/${status.totalDocs})`
				};
			}

			return {
				text: `pushing ${status.docsWritten}`,
				title: "Processing remote operations"
			};
		}

		case "pushed":
			return {
				text: `pushed ${status.docsWritten}`,
				title: "Push complete",
				returnToIdle: true
			};

		case "pulling":
			return {
				text: `reading ${status.docsRead}`,
				title: "Pulling from remote"
			};

		case "pulled":
			return {
				text: `restored ${status.restored}, deleted ${status.deleted}`,
				title: `Read ${status.docsRead}, restored ${status.restored}, deleted ${status.deleted}, skipped ${status.skipped}, conflicts ${status.conflicts}`,
				returnToIdle: true
			};

		case "cleaning-empty-folders":
			return {
				text: `cleaning ${status.current}/${status.total}`,
				title: `Removed ${status.removed}, skipped ${status.skipped}`
			};

		case "empty-folders-cleaned":
			return {
				text: `removed ${status.removed} folders`,
				title: `Removed ${status.removed} empty folder(s), skipped ${status.skipped}`,
				returnToIdle: true
			};

		case "resetting-local-databases":
			return {
				text: "resetting local data",
				title: "Resetting local MySync databases"
			};

		case "local-databases-reset":
			return {
				text: "local data reset",
				title: "Local MySync databases were reset",
				returnToIdle: true
			};

		case "deleting":
			return {
				text: `delete ${status.current}/${status.total}`,
				title: `Deleted ${status.deleted}, skipped ${status.skipped}, conflicts ${status.conflicts}`
			};

		case "restoring": {
			const percent = calculatePercent(status.current, status.total);
			return {
				text: `restoring ${percent}%`,
				title: `Restored ${status.restored}, skipped ${status.skipped}, conflicts ${status.conflicts}`
			};
		}

		case "testing":
			return {
				text: "testing",
				title: "Testing remote connection"
			};

		case "tested":
			return {
				text: "tested",
				title: `Connected to ${status.databaseName}`,
				returnToIdle: true
			};

		case "error":
			return {
				text: "MySync error",
				title: status.message,
				returnToIdle: true
			};

		default:
			return assertNever(status);
	}
}

function calculatePercent(current: number, total: number): number {
	return total > 0 ? Math.round((current / total) * 100) : 0;
}

function assertNever(value: never): never {
	throw new Error(`Unhandled sync status: ${JSON.stringify(value)}`);
}
