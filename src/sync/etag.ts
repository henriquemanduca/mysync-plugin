/**
 * Normalizes an ETag by stripping weak validator prefixes (W/ or w/) and surrounding quotes.
 */
export function normalizeEtag(etag?: string | null): string {
	if (!etag) return "";
	let val = etag.trim();
	if (val.startsWith("W/") || val.startsWith("w/")) {
		val = val.slice(2).trim();
	}
	while (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
		val = val.slice(1, -1).trim();
	}
	return val;
}

/**
 * Checks if two ETags are equivalent, ignoring weak validator prefixes and surrounding quotes.
 */
export function areEtagsEqual(a?: string | null, b?: string | null): boolean {
	const normA = normalizeEtag(a);
	const normB = normalizeEtag(b);
	if (!normA && !normB) {
		return a === b;
	}
	return normA === normB;
}

/**
 * Formats an ETag for conditional HTTP request headers (such as If-Match / If-None-Match),
 * ensuring proper quoting as specified in RFC 7232. Wildcards are preserved as '*'.
 */
export function formatConditionalEtag(etag: string): string {
	if (etag === "*") return "*";
	const normalized = normalizeEtag(etag);
	return normalized ? `"${normalized}"` : etag;
}
