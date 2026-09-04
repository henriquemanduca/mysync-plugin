export type NextcloudPathValidation =
	| { valid: true }
	| { valid: false; reasons: string[] };

const RESERVED_FILE_NAMES = new Set([
	".htaccess"
]);

const RESERVED_FILE_ENDINGS = [
	".filepart",
	".part"
];

export function validateNextcloudFilePath(path: string): NextcloudPathValidation {
	const reasons = new Set<string>();

	if (path.length === 0) {
		reasons.add("path is empty");
	}

	if (path.includes("\\")) {
		reasons.add("contains a backslash");
	}

	const controlCharacters = findAsciiControlCharacters(path);
	if (controlCharacters.length > 0) {
		reasons.add(`contains ASCII control characters: ${controlCharacters.join(", ")}`);
	}

	for (const segment of path.split("/")) {
		if (segment.length === 0) {
			reasons.add("contains an empty path segment");
			continue;
		}

		if (segment === "." || segment === "..") {
			reasons.add(`contains the reserved path segment ${segment}`);
		}

		const normalizedSegment = segment.toLowerCase();
		if (RESERVED_FILE_NAMES.has(normalizedSegment)) {
			reasons.add(`contains the reserved name ${segment}`);
		}

		const reservedEnding = RESERVED_FILE_ENDINGS.find(
			(ending) => normalizedSegment.endsWith(ending)
		);
		if (reservedEnding) {
			reasons.add(`contains a name ending with the reserved extension ${reservedEnding}`);
		}
	}

	return reasons.size === 0
		? { valid: true }
		: { valid: false, reasons: Array.from(reasons) };
}

function findAsciiControlCharacters(path: string) {
	const codes = new Set<number>();

	for (const character of path) {
		const code = character.codePointAt(0);
		if (typeof code === "number" && code <= 31) {
			codes.add(code);
		}
	}

	return Array.from(codes).map(formatControlCharacter);
}

function formatControlCharacter(code: number) {
	switch (code) {
		case 9:
			return "TAB (U+0009)";
		case 10:
			return "LF (U+000A)";
		case 13:
			return "CR (U+000D)";
		default:
			return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
	}
}
