import { vi } from "vitest";

export interface FileStats {
	ctime: number;
	mtime: number;
	size: number;
}

export class TAbstractFile {
	name: string;
	path: string;
	parent: TFolder | null = null;
	vault: unknown = null;

	constructor(path: string) {
		this.path = normalizePath(path);
		this.name = this.path.slice(this.path.lastIndexOf("/") + 1);
	}
}

export class TFile extends TAbstractFile {
	basename: string;
	extension: string;
	stat: FileStats;

	constructor(path: string, contentSize = 0, mtime = 0) {
		super(path);
		const dotIndex = this.name.lastIndexOf(".");
		this.extension = dotIndex > 0 ? this.name.slice(dotIndex + 1) : "";
		this.basename = dotIndex > 0 ? this.name.slice(0, dotIndex) : this.name;
		this.stat = {
			ctime: mtime,
			mtime,
			size: contentSize
		};
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	constructor(path: string, children: TAbstractFile[] = []) {
		super(path);
		this.children = children;

		for (const child of children) {
			child.parent = this;
		}
	}
}

export class Notice {
	static instances: Notice[] = [];
	hidden = false;

	constructor(
		public message: string | DocumentFragment,
		public timeout?: number
	) {
		Notice.instances.push(this);
	}

	setMessage(message: string | DocumentFragment): this {
		this.message = message;
		return this;
	}

	hide() {
		this.hidden = true;
	}
}

export const Platform = {
	isAndroidApp: false,
	isDesktop: true,
	isDesktopApp: true,
	isIosApp: false,
	isMobile: false,
	isMobileApp: false,
	isPhone: false,
	isTablet: false,
	resourcePathPrefix: ""
};

export class App {}

export function getLanguage() {
	return "en";
}

export function normalizePath(path: string) {
	const normalized = path
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\/|\/$/g, "");

	return normalized || "/";
}

export const requestUrl = vi.fn(async (): Promise<never> => {
	throw new Error("requestUrl is not implemented in unit tests.");
});
