import { afterEach } from "vitest";
import { Notice } from "./mocks/obsidian";

afterEach(() => {
	Notice.instances.length = 0;
});
