import { Setting } from "obsidian";
import type MySyncPlugin from "../../../main";
import { setDestructiveButton } from "../../../utils/button";
import { addReadonlyDateSetting } from "./local-config-section";

export function renderLocalDataSection(containerEl: HTMLElement, plugin: MySyncPlugin): void {
	addReadonlyDateSetting(
		containerEl,
		"Last local database reset",
		"Last time the local file and conflict databases were reset.",
		plugin.settings.lastLocalDatabaseResetAt
	);

	new Setting(containerEl)
		.setName("Reset local databases")
		.setDesc("Delete the local file index, conflicts, revisions, baselines, and replication checkpoints. Vault files and remote data are not changed.")
		.addButton((button) => {
			button.setButtonText("Reset local databases").then(() => {});
			setDestructiveButton(button)
				.onClick(() => plugin.openLocalDatabaseResetModal()).then(() => {});
		}).then(() => {});
}
