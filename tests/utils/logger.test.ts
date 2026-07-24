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
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const logger = new Logger("Test");

		logger.error("Connection failed", undefined, {
			apiToken: "token-value",
			nested: {
				password: "password-value",
				safe: "visible"
			}
		});

		expect(errorSpy).toHaveBeenCalledWith("[MySync:Test] Connection failed", {
			apiToken: "[REDACTED]",
			nested: {
				password: "[REDACTED]",
				safe: "visible"
			}
		});
	});

	it("does not write messages below the configured level", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const logger = new Logger("Test");
		Logger.setLevel("error");

		logger.debug("Skipped");
		logger.error("Written");

		expect(errorSpy).toHaveBeenCalledOnce();
	});

	it("does not write non-error messages to the console", () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const logger = new Logger("Test");

		logger.debug("Debug");
		logger.log("Log");
		logger.info("Info");
		logger.warn("Warning");

		expect(debugSpy).not.toHaveBeenCalled();
		expect(logSpy).not.toHaveBeenCalled();
		expect(infoSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
