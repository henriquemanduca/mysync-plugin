import { afterEach } from "vitest";
import { Notice } from "./mocks/obsidian";

if (typeof window === "undefined") {
	(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}

afterEach(() => {
	Notice.instances.length = 0;
});
