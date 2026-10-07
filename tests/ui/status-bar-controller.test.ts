import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { StatusBarController } from "../../src/ui/status-bar/status-bar-controller";
import type { MySyncSettings } from "../../src/core";
import { DEFAULT_SETTINGS } from "../../src/core/constants/default-settings";

class MockElement {
	text = "";
	title = "";
	classes = new Set<string>();
	eventListeners: Record<string, () => void> = {};

	empty() {
		this.text = "";
	}

	addClass(cls: string) {
		this.classes.add(cls);
	}

	toggleClass(cls: string, val: boolean) {
		if (val) this.classes.add(cls);
		else this.classes.delete(cls);
	}

	setText(val: string) {
		this.text = val;
	}

	addEventListener(event: string, cb: () => void) {
		this.eventListeners[event] = cb;
	}
}

describe("StatusBarController", () => {
	let settings: MySyncSettings;
	let mockEl: MockElement;
	let conflictClickMock: () => void;

	beforeEach(() => {
		vi.useFakeTimers();
		settings = { ...DEFAULT_SETTINGS, lastRemotePushAt: "2026-10-07T12:00:00Z" };
		mockEl = new MockElement();
		conflictClickMock = vi.fn();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders idle status with formatted last push time", () => {
		const controller = new StatusBarController(
			mockEl as any,
			() => settings,
			conflictClickMock
		);

		expect(mockEl.classes.has("mysync-status")).toBe(true);
		expect(mockEl.text).not.toBe("...");
		expect(mockEl.text.length).toBeGreaterThan(0);
		controller.destroy();
	});

	it("renders active conflicts indicator and triggers click handler", () => {
		const controller = new StatusBarController(
			mockEl as any,
			() => settings,
			conflictClickMock
		);

		controller.updateConflictCount(2);

		expect(mockEl.text).toContain("2 conflicts");
		expect(mockEl.classes.has("mysync-status-has-conflicts")).toBe(true);

		mockEl.eventListeners["click"]?.();
		expect(conflictClickMock).toHaveBeenCalled();

		controller.destroy();
	});

	it("returns to idle after temporary statuses like done", () => {
		const controller = new StatusBarController(
			mockEl as any,
			() => settings,
			conflictClickMock
		);

		controller.updateSyncStatus({ state: "done", total: 1, saved: 1, skipped: 0 });
		expect(mockEl.text).toBe("Saved 1");

		vi.advanceTimersByTime(5000);
		expect(controller.getCurrentStatus().state).toBe("idle");

		controller.destroy();
	});
});
