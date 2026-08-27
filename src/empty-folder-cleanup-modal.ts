import { Modal, Setting } from "obsidian";
import type { EmptyFolderCleanupResult } from "./sync/sync-service";
import { setDestructiveButton } from "./utils/button";

export class EmptyFolderCleanupModal extends Modal {
	private cleaning = false;

	constructor(
		app: ConstructorParameters<typeof Modal>[0],
		private folderCount: number,
		private cleanEmptyFolders: () => Promise<EmptyFolderCleanupResult | null>,
		private onClosed: () => void
	) {
		super(app);
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
		this.titleEl.setText("Clean empty folders");
		this.contentEl.createEl("p", {
			text: `${this.folderCount} empty folder(s) will be moved to the configured trash.`
		});
		this.contentEl.createEl("p", {
			text: "The vault root and Obsidian configuration folder will be preserved.",
			cls: "mysync-reset-scope-note"
		});

		const actions = new Setting(this.contentEl);
		actions.addButton((button) => button
			.setButtonText("Cancel")
			.setDisabled(this.cleaning)
			.onClick(() => this.close()));
		actions.addButton((button) => {
			button.setButtonText(this.cleaning ? "Cleaning..." : "Move empty folders to trash");
			setDestructiveButton(button)
				.setCta()
				.setDisabled(this.cleaning)
				.onClick(() => void this.runCleanup());
		});
	}

	private async runCleanup() {
		if (this.cleaning) {
			return;
		}

		this.cleaning = true;
		this.render();

		const result = await this.cleanEmptyFolders();

		if (result) {
			this.close();
			return;
		}

		this.cleaning = false;
		this.render();
	}
}
