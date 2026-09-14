import { describe, expect, it } from "vitest";
import { areEtagsEqual, formatConditionalEtag, normalizeEtag } from "../../src/sync/etag";

describe("etag utils", () => {
	describe("normalizeEtag", () => {
		it("normalizes strong quoted etags", () => {
			expect(normalizeEtag('"abcdef"')).toBe("abcdef");
		});

		it("normalizes weak etags", () => {
			expect(normalizeEtag('W/"abcdef"')).toBe("abcdef");
			expect(normalizeEtag('w/"abcdef"')).toBe("abcdef");
		});

		it("normalizes unquoted etags", () => {
			expect(normalizeEtag("abcdef")).toBe("abcdef");
		});

		it("trims whitespace", () => {
			expect(normalizeEtag('  W/"abcdef"  ')).toBe("abcdef");
			expect(normalizeEtag('  "abcdef"  ')).toBe("abcdef");
			expect(normalizeEtag("  abcdef  ")).toBe("abcdef");
		});

		it("handles null, undefined, and empty string", () => {
			expect(normalizeEtag(undefined)).toBe("");
			expect(normalizeEtag(null)).toBe("");
			expect(normalizeEtag("")).toBe("");
			expect(normalizeEtag('""')).toBe("");
		});
	});

	describe("areEtagsEqual", () => {
		it("treats strong and weak etags with the same value as equal", () => {
			expect(areEtagsEqual('"abcdef"', 'W/"abcdef"')).toBe(true);
			expect(areEtagsEqual('W/"abcdef"', '"abcdef"')).toBe(true);
		});

		it("treats quoted and unquoted etags with the same value as equal", () => {
			expect(areEtagsEqual('"abcdef"', "abcdef")).toBe(true);
			expect(areEtagsEqual("abcdef", 'W/"abcdef"')).toBe(true);
		});

		it("detects differences when values differ", () => {
			expect(areEtagsEqual('"abc"', '"xyz"')).toBe(false);
			expect(areEtagsEqual('W/"abc"', '"xyz"')).toBe(false);
		});

		it("handles undefined and null comparisons", () => {
			expect(areEtagsEqual(undefined, undefined)).toBe(true);
			expect(areEtagsEqual(null, null)).toBe(true);
			expect(areEtagsEqual("abc", undefined)).toBe(false);
			expect(areEtagsEqual(undefined, "abc")).toBe(false);
		});
	});

	describe("formatConditionalEtag", () => {
		it("formats unquoted etag into quoted etag", () => {
			expect(formatConditionalEtag("abcdef")).toBe('"abcdef"');
		});

		it("preserves properly quoted etag without double quoting", () => {
			expect(formatConditionalEtag('"abcdef"')).toBe('"abcdef"');
		});

		it("strips weak prefix and quotes the etag", () => {
			expect(formatConditionalEtag('W/"abcdef"')).toBe('"abcdef"');
		});

		it("preserves wildcard *", () => {
			expect(formatConditionalEtag("*")).toBe("*");
		});
	});
});
