import { describe, expect, it } from "vitest";
import { isPouchConflict, isPouchNotFound } from "../../src/utils/pouchdb-errors";

describe("PouchDB error guards", () => {
	it("recognizes conflict responses", () => {
		expect(isPouchConflict({ status: 409 })).toBe(true);
		expect(isPouchConflict({ status: 404 })).toBe(false);
		expect(isPouchConflict(new Error("conflict"))).toBe(false);
	});

	it("recognizes not-found responses", () => {
		expect(isPouchNotFound({ status: 404 })).toBe(true);
		expect(isPouchNotFound({ status: 409 })).toBe(false);
		expect(isPouchNotFound(null)).toBe(false);
	});
});
