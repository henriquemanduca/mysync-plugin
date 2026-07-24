import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../src/utils/date-format";

describe("formatDateTime", () => {
	it("returns the configured fallback for an empty value", () => {
		expect(formatDateTime("", { fallback: "Never" })).toBe("Never");
	});

	it("returns the configured invalid fallback for an invalid date", () => {
		expect(formatDateTime("not-a-date", {
			fallback: "Never",
			invalidFallback: "Invalid"
		})).toBe("Invalid");
	});

	it("formats a valid date without a time when requested", () => {
		const value = "2026-07-24T15:30:00.000Z";
		const expected = new Intl.DateTimeFormat("en", {
			dateStyle: "short"
		}).format(new Date(value));

		expect(formatDateTime(value, { includeTime: false })).toBe(expected);
	});
});
