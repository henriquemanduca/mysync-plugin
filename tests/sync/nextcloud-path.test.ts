import { describe, expect, it } from "vitest";
import { validateNextcloudFilePath } from "../../src/sync/nextcloud-path";

describe("validateNextcloudFilePath", () => {
	it("accepts regular paths with spaces and Unicode characters", () => {
		expect(validateNextcloudFilePath("Área de trabalho/Notas do dia.pdf"))
			.toEqual({ valid: true });
	});

	it.each([
		["line feed", "Folder/File\nname.pdf", "LF (U+000A)"],
		["carriage return", "Folder/File\rname.pdf", "CR (U+000D)"],
		["tab", "Folder/File\tname.pdf", "TAB (U+0009)"],
		["null", `Folder/File${String.fromCharCode(0)}name.pdf`, "U+0000"]
	])("rejects an ASCII %s character", (_name, path, reason) => {
		const result = validateNextcloudFilePath(path);

		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reasons.join(" ")).toContain(reason);
		}
	});

	it.each([
		["backslash", "Folder\\File.pdf", "contains a backslash"],
		["empty segment", "Folder//File.pdf", "contains an empty path segment"],
		["current directory segment", "Folder/./File.pdf", "reserved path segment ."],
		["parent directory segment", "Folder/../File.pdf", "reserved path segment .."],
		["reserved filename", "Folder/.HTACCESS", "reserved name .HTACCESS"],
		["part extension", "Folder/File.PART", "reserved extension .part"],
		["filepart extension", "Folder/File.FILEPART", "reserved extension .filepart"]
	])("rejects a path with a %s", (_name, path, reason) => {
		const result = validateNextcloudFilePath(path);

		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reasons.join(" ")).toContain(reason);
		}
	});
});
