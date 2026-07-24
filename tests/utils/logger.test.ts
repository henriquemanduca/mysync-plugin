import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger, isLoggerLevel } from "../../src/utils/logger";

describe("Logger", () => {
	afterEach(() => {
		Logger.setLevel("debug");
	});

	it("recognizes supported log levels", () => {
		expect(["debug", "log", "info", "warn", "error", "off"].every(isLoggerLevel)).toBe(true);
		expect(isLoggerLevel("trace")).toBe(false);
	});

	it("redacts sensitive and nested values before logging", () => {
		const logSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const logger = new Logger("Test");

		logger.info("Connected", {
			apiToken: "token-value",
			nested: {
				password: "password-value",
				safe: "visible"
			}
		});

		expect(logSpy).toHaveBeenCalledWith("[MySync:Test] Connected", {
			apiToken: "[REDACTED]",
			nested: {
				password: "[REDACTED]",
				safe: "visible"
			}
		});
	});

	it("does not write messages below the configured level", () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const logger = new Logger("Test");
		Logger.setLevel("error");

		logger.debug("Skipped");
		logger.error("Written");

		expect(debugSpy).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledOnce();
	});
});
