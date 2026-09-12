/**
 * OpenCloud WebDAV URLs commonly percent-encode the `$` separator as `%24`.
 * Settings store the resource ID in its raw form so URL construction can encode
 * it exactly once.
 */
export function normalizeOpenCloudSpaceId(value: string): string {
	return value.trim().replace(/%24/gi, "$");
}
