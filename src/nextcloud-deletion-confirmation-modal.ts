import { Modal, Setting } from "obsidian";
import type { NextcloudDeletionConfirmation } from "./sync/sync-service";
import { setDestructiveButton } from "./utils/button";

export class NextcloudDeletionConfirmationModal extends Modal {
	private settled = false;

	constructor(
		app: ConstructorParameters<typeof Modal>[0],
		private details: NextcloudDeletionConfirmation,
		private settle: (confirmed: boolean) => void
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Confirm remote deletions");
		this.contentEl.createEl("p", {
			text: `${this.details.count} local files (${this.details.percentage.toFixed(1)}%) are absent from the previous Nextcloud snapshot.`
		});
		this.contentEl.createEl("p", { text: `Remote target: ${this.details.target}` });
		this.contentEl.createEl("p", {
			text: "Continuing moves these local files to the configured trash.",
			cls: "mysync-reset-warning"
		});
		const actions = new Setting(this.contentEl);
		actions.addButton((button) => button
			.setButtonText("Cancel")
			.onClick(() => this.finish(false)));
		actions.addButton((button) => {
			button.setButtonText("Delete local files").setCta();
			setDestructiveButton(button).onClick(() => this.finish(true));
		});
	}

	onClose() {
		this.contentEl.empty();
		if (!this.settled) this.finish(false, false);
	}

	private finish(confirmed: boolean, close = true) {
		if (this.settled) return;
		this.settled = true;
		this.settle(confirmed);
		if (close) this.close();
	}
}
