import { Modal, Setting } from "obsidian";
import type { ConflictResolutionStrategy, SyncConflict } from "../../core/types/conflict.types";

interface ConflictAction {
	label: string;
	strategy: ConflictResolutionStrategy;
}

export class ConflictResolutionModal extends Modal {
	private conflicts: SyncConflict[];
	private resolving = false;

	constructor(
		app: ConstructorParameters<typeof Modal>[0],
		conflicts: SyncConflict[],
		private resolveConflict: (
			conflictId: string,
			strategy: ConflictResolutionStrategy
		) => Promise<void>,
		private retryConflictPush: (conflictId: string) => Promise<void>,
		private onClosed: () => void
	) {
		super(app);
		this.conflicts = conflicts;
	}

	updateConflicts(conflicts: SyncConflict[]) {
		this.conflicts = conflicts;

		if (!this.resolving) {
			this.render();
		}
	}

	onOpen() {
		this.render();
	}

	onClose() {
		this.contentEl.empty();
		this.onClosed();
	}

	private render() {
		this.contentEl.empty();
		this.titleEl.setText("Resolve sync conflicts");

		if (this.conflicts.length === 0) {
			this.contentEl.createEl("p", {
				text: "There are no unresolved sync conflicts."
			});
			return;
		}

		this.contentEl.createEl("p", {
			text: `${this.conflicts.length} conflict(s) require manual resolution. Choose how each file should be preserved:`
		});

		for (const conflict of this.conflicts) {
			this.renderConflictItem(conflict);
		}
	}

	private renderConflictItem(conflict: SyncConflict) {
		const setting = new Setting(this.contentEl)
			.setName(conflict.path)
			.setDesc(formatConflictDescription(conflict));

		setting.settingEl.addClass("mysync-conflict-item");

		if (conflict.status === "error" && conflict.error) {
			setting.settingEl.createEl("p", {
				text: `Error: ${conflict.error}`,
				cls: "mysync-conflict-error"
			});
		}

		for (const action of getAvailableConflictActions(conflict)) {
			setting.addButton((button) => {
				button
					.setButtonText(action.label)
					.setDisabled(this.resolving)
					.onClick(() => void this.runResolution(conflict._id, action.strategy));

				if (action.strategy === "keep-both") {
					button.setCta();
				}
			});
		}

		if (conflict.status === "pending-push") {
			setting.addButton((button) => {
				button
					.setButtonText("Retry push")
					.setDisabled(this.resolving)
					.onClick(() => void this.runRetryPush(conflict._id));
			});
		}
	}

	private async runResolution(conflictId: string, strategy: ConflictResolutionStrategy) {
		if (this.resolving) {
			return;
		}

		this.resolving = true;
		this.render();

		try {
			await this.resolveConflict(conflictId, strategy);
		} finally {
			this.resolving = false;
			this.conflicts = this.conflicts.filter((item) => item._id !== conflictId);

			if (this.conflicts.length === 0) {
				this.close();
				return;
			}

			this.render();
		}
	}

	private async runRetryPush(conflictId: string) {
		if (this.resolving) {
			return;
		}

		this.resolving = true;
		this.render();

		try {
			await this.retryConflictPush(conflictId);
		} finally {
			this.resolving = false;
			this.render();
		}
	}
}

function getAvailableConflictActions(conflict: SyncConflict): ConflictAction[] {
	switch (conflict.kind) {
		case "local-delete-remote-edit":
			return [
				{ label: "Restore remote file", strategy: "keep-remote" },
				{ label: "Delete permanently", strategy: "delete" }
			];
		case "local-edit-remote-delete":
			return [
				{ label: "Keep local file", strategy: "keep-local" },
				{ label: "Delete local file", strategy: "delete" }
			];
		case "edit-edit":
		case "path-collision":
		default:
			return [
				{ label: "Keep both files", strategy: "keep-both" },
				{ label: "Keep local file", strategy: "keep-local" },
				{ label: "Keep remote file", strategy: "keep-remote" }
			];
	}
}

function formatConflictDescription(conflict: SyncConflict): string {
	const base = `Kind: ${conflict.kind} · Status: ${conflict.status}`;
	const detectedAt = conflict.detectedAt ? ` · Detected: ${conflict.detectedAt}` : "";
	return `${base}${detectedAt}`;
}

