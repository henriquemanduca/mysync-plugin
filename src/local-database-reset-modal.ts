import { Modal, Setting } from "obsidian";
import { setDestructiveButton } from "./utils/button";

export class LocalDatabaseResetModal extends Modal {
	private resetting = false;

	constructor(
		app: ConstructorParameters<typeof Modal>[0],
		private fileDatabaseName: string,
		private conflictDatabaseName: string,
		private resetLocalDatabases: () => Promise<boolean>,
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
		this.titleEl.setText("Reset local databases");

		this.contentEl.createEl("p", {
			text: "This permanently deletes the local MySync index and conflict history."
		});

		const databaseList = this.contentEl.createEl("ul", {
			cls: "mysync-reset-database-list"
		});
		this.addDatabaseName(databaseList, "File database", this.fileDatabaseName);
		this.addDatabaseName(databaseList, "Conflict database", this.conflictDatabaseName);

		this.contentEl.createEl("p", {
			text: "Vault files and the remote CouchDB database are not changed.",
			cls: "mysync-reset-scope-note"
		});
		this.contentEl.createEl("p", {
			text: "Local revisions, conflicts, baselines, and replication checkpoints cannot be recovered. Pull before pushing to an existing remote database.",
			cls: "mysync-reset-warning"
		});

		const actions = new Setting(this.contentEl);
		actions.addButton((button) => button
			.setButtonText("Cancel")
			.setDisabled(this.resetting)
			.onClick(() => this.close()));
		actions.addButton((button) => {
			button.setButtonText(this.resetting ? "Resetting..." : "Reset local databases");
			setDestructiveButton(button)
				.setCta()
				.setDisabled(this.resetting)
				.onClick(() => void this.runReset());
		});
	}

	private addDatabaseName(containerEl: HTMLElement, label: string, databaseName: string) {
		const itemEl = containerEl.createEl("li");
		itemEl.createSpan({ text: `${label}: ` });
		itemEl.createEl("code", { text: databaseName });
	}

	private async runReset() {
		if (this.resetting) {
			return;
		}

		this.resetting = true;
		this.render();

		const succeeded = await this.resetLocalDatabases();

		if (succeeded) {
			this.close();
			return;
		}

		this.resetting = false;
		this.render();
	}
}
