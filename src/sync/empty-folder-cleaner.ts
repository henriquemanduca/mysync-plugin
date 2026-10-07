import { type App, TFolder } from "obsidian";
import type { EmptyFolderCleanupResult } from "../core";
import { Logger } from "../utils/logger";

const logger = new Logger("EmptyFolderCleaner");

export class EmptyFolderCleaner {
	constructor(private readonly app: App) {}

	getEmptyVaultFolderCount(): number {
		return this.collectEmptyVaultFolders().length;
	}

	collectEmptyVaultFolders(): TFolder[] {
		const folders: TFolder[] = [];
		const configFolder = this.app.vault.configDir.trim().replace(/^\/+|\/+$/g, "");

		const collect = (folder: TFolder): boolean => {
			if (
				folder.path === configFolder
				|| (configFolder.length > 0 && folder.path.startsWith(`${configFolder}/`))
			) {
				return false;
			}

			let canRemoveFolder = true;

			for (const child of folder.children) {
				if (child instanceof TFolder) {
					canRemoveFolder = collect(child) && canRemoveFolder;
				} else {
					canRemoveFolder = false;
				}
			}

			if (folder === this.app.vault.getRoot()) {
				return false;
			}

			if (canRemoveFolder) {
				folders.push(folder);
				return true;
			}

			return false;
		};

		collect(this.app.vault.getRoot());
		return folders;
	}

	async removeEmptyFolder(folder: TFolder): Promise<boolean> {
		if (folder.children.length > 0) {
			return false;
		}

		try {
			await this.app.fileManager.trashFile(folder);
			return true;
		} catch (error) {
			logger.warn("Failed to remove empty folder", error, { path: folder.path });
			return false;
		}
	}

	async cleanEmptyVaultFolders(
		onProgress?: (progress: { current: number; total: number; removed: number; skipped: number }) => void
	): Promise<EmptyFolderCleanupResult> {
		const folders = this.collectEmptyVaultFolders();
		let removed = 0;
		let skipped = 0;

		for (const [index, folder] of folders.entries()) {
			if (await this.removeEmptyFolder(folder)) {
				removed += 1;
			} else {
				skipped += 1;
			}

			onProgress?.({
				current: index + 1,
				total: folders.length,
				removed,
				skipped
			});
		}

		return { total: folders.length, removed, skipped };
	}
}

