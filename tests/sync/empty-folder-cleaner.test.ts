import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "../mocks/obsidian";
import { EmptyFolderCleaner } from "../../src/sync/empty-folder-cleaner";

describe("EmptyFolderCleaner", () => {
	it("collects empty folders and ignores root and configDir", () => {
		const emptySubfolder = new TFolder("Notes/Empty");
		const fileInFolder = new TFile("Notes/Active/file.md");
		const activeFolder = new TFolder("Notes/Active", [fileInFolder]);
		const notesFolder = new TFolder("Notes", [emptySubfolder, activeFolder]);

		const configSubfolder = new TFolder(".obsidian/plugins");
		const configFolder = new TFolder(".obsidian", [configSubfolder]);

		const rootFolder = new TFolder("/", [notesFolder, configFolder]);

		const app = {
			vault: {
				configDir: ".obsidian",
				getRoot: () => rootFolder
			},
			fileManager: {
				trashFile: vi.fn().mockResolvedValue(undefined)
			}
		} as any;

		const cleaner = new EmptyFolderCleaner(app);
		const emptyFolders = cleaner.collectEmptyVaultFolders();

		expect(emptyFolders.map((f) => f.path)).toContain("Notes/Empty");
		expect(emptyFolders.map((f) => f.path)).not.toContain("/");
		expect(emptyFolders.map((f) => f.path)).not.toContain(".obsidian");
		expect(emptyFolders.map((f) => f.path)).not.toContain("Notes/Active");
	});

	it("removes an empty folder successfully", async () => {
		const emptyFolder = new TFolder("Empty");
		const trashFileMock = vi.fn().mockResolvedValue(undefined);

		const app = {
			vault: {
				configDir: ".obsidian",
				getRoot: () => new TFolder("/")
			},
			fileManager: {
				trashFile: trashFileMock
			}
		} as any;

		const cleaner = new EmptyFolderCleaner(app);
		const removed = await cleaner.removeEmptyFolder(emptyFolder as any);

		expect(removed).toBe(true);
		expect(trashFileMock).toHaveBeenCalledWith(emptyFolder);
	});

	it("does not remove a folder if it contains children", async () => {
		const nonEmptyFolder = new TFolder("NonEmpty", [new TFile("NonEmpty/note.md")]);
		const trashFileMock = vi.fn().mockResolvedValue(undefined);

		const app = {
			vault: {
				configDir: ".obsidian",
				getRoot: () => new TFolder("/")
			},
			fileManager: {
				trashFile: trashFileMock
			}
		} as any;

		const cleaner = new EmptyFolderCleaner(app);
		const removed = await cleaner.removeEmptyFolder(nonEmptyFolder as any);

		expect(removed).toBe(false);
		expect(trashFileMock).not.toHaveBeenCalled();
	});
});
