import { getLanguage } from "obsidian";

interface FormatDateTimeOptions {
	includeTime?: boolean;
	fallback?: string;
	invalidFallback?: string;
}

export function formatDateTime(value: string, options: FormatDateTimeOptions = {}): string {
	const {
		includeTime = true,
		fallback = "",
		invalidFallback = fallback
	} = options;

	if (!value) {
		return fallback;
	}

	const date = new Date(value);

	if (Number.isNaN(date.getTime())) {
		return invalidFallback;
	}

	return new Intl.DateTimeFormat(getPreferredLocale(), {
		dateStyle: "short",
		timeStyle: includeTime ? "short" : undefined
	}).format(date);
}

function getPreferredLocale(): string {
	return getLanguage() || navigator.language || "en";
}
