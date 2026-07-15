import { Modal, Setting } from "obsidian";
import type { ConflictResolutionStrategy, SyncConflict } from "./sync/types";

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
		const conflict = this.conflicts[0];

		if (!conflict) {
			this.close();
			return;
		}

		const conflictPosition = this.conflicts.length > 1
			? ` (${this.conflicts.length} remaining)`
			: "";
		this.titleEl.setText(`Resolve sync conflict${conflictPosition}`);
		this.contentEl.createEl("p", {
			text: conflict.path,
			cls: "mysync-conflict-path"
		});

		if (conflict.error) {
			this.contentEl.createEl("p", {
				text: conflict.error,
				cls: "mysync-conflict-error"
			});
		}

		if (conflict.status === "pending-push") {
			this.contentEl.createEl("p", {
				text: "Your choice was applied locally, but could not be sent to the remote database."
			});
			new Setting(this.contentEl)
				.addButton((button) => button
					.setButtonText("Retry")
					.setCta()
					.onClick(() => void this.runAction(
						() => this.retryConflictPush(conflict._id)
					)));
			return;
		}

		this.contentEl.createEl("p", {
			text: "Choose which version to keep."
		});
		const actions = new Setting(this.contentEl);

		for (const action of getConflictActions(conflict)) {
			actions.addButton((button) => button
				.setButtonText(action.label)
				.onClick(() => void this.runAction(
					() => this.resolveConflict(conflict._id, action.strategy)
				)));
		}
	}

	private async runAction(action: () => Promise<void>) {
		if (this.resolving) {
			return;
		}

		this.resolving = true;
		this.contentEl.querySelectorAll("button").forEach((button) => {
			button.disabled = true;
		});

		try {
			await action();
		} finally {
			this.resolving = false;
			this.render();
		}
	}
}

function getConflictActions(conflict: SyncConflict): ConflictAction[] {
	const hasLocalFile = conflict.localVariant.exists;
	const hasRemoteFile = conflict.remoteVariants.some((variant) => !variant.deleted);
	const actions: ConflictAction[] = [];

	if (hasLocalFile) {
		actions.push({ label: "Keep local", strategy: "keep-local" });
	} else if (conflict.kind === "local-delete-remote-edit") {
		actions.push({ label: "Keep local", strategy: "delete" });
	}

	if (hasRemoteFile) {
		actions.push({ label: "Keep remote", strategy: "keep-remote" });
	} else if (conflict.kind === "local-edit-remote-delete") {
		actions.push({ label: "Keep remote", strategy: "delete" });
	}

	if (hasLocalFile && hasRemoteFile) {
		actions.push({ label: "Keep both", strategy: "keep-both" });
	}

	return actions;
}
