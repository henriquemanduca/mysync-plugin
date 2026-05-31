import type { DataAdapter } from "obsidian";
import { normalizePath } from "obsidian";

type LogContext = Record<string, unknown>;
type LogLevel = "debug" | "error" | "info" | "log" | "warn";

interface FileLogTarget {
	adapter: DataAdapter;
	path: string;
}

export class Logger {
	private static fileTarget: FileLogTarget | null = null;
	private static writeQueue = Promise.resolve();

	constructor(private scope: string) { }

	static configureFileLogging(adapter: DataAdapter, pluginDir: string) {
		Logger.fileTarget = {
			adapter,
			path: normalizePath(`${pluginDir}/mysync.log`)
		};

		Logger.enqueueFileWrite(`${formatTimestamp()} [info] [MySync:Logger] File logging started\n`);
	}

	static async flush() {
		await Logger.writeQueue;
	}

	method(methodName: string, context?: LogContext) {
		this.log(`${methodName}()`, context);
	}

	debug(message: string, context?: LogContext) {
		this.write("debug", message, context);
	}

	error(message: string, error?: unknown, context?: LogContext) {
		this.write("error", message, context, error);
	}

	info(message: string, context?: LogContext) {
		this.write("info", message, context);
	}

	log(message: string, context?: LogContext) {
		this.write("log", message, context);
	}

	warn(message: string, error?: unknown, context?: LogContext) {
		this.write("warn", message, context, error);
	}

	private write(level: LogLevel, message: string, context?: LogContext, error?: unknown) {
		const prefix = `[MySync:${this.scope}] ${message}`;
		const sanitizedContext = sanitizeForLog(context);
		const sanitizedError = sanitizeForLog(error);
		const args: unknown[] = sanitizedContext ? [prefix, sanitizedContext] : [prefix];

		if (sanitizedError !== undefined) {
			args.push(sanitizedError);
		}

		console[level](...args);
		Logger.enqueueFileWrite(formatLogLine(level, this.scope, message, sanitizedContext, sanitizedError));
	}

	private static enqueueFileWrite(line: string) {
		if (!Logger.fileTarget) {
			return;
		}

		const { adapter, path } = Logger.fileTarget;

		Logger.writeQueue = Logger.writeQueue
			.then(() => adapter.append(path, line))
			.catch((error) => {
				console.warn("[MySync:Logger] Failed to write log file", error);
			});
	}
}

function formatLogLine(
	level: LogLevel,
	scope: string,
	message: string,
	context?: unknown,
	error?: unknown
) {
	return `${formatTimestamp()} [${level}] [MySync:${scope}] ${message}${formatDetails(context, error)}\n`;
}

function formatTimestamp() {
	return new Date().toISOString();
}

function formatDetails(context?: unknown, error?: unknown) {
	const details: Record<string, unknown> = {};

	if (context !== undefined) {
		details.context = context;
	}

	if (error !== undefined) {
		details.error = error;
	}

	if (Object.keys(details).length === 0) {
		return "";
	}

	return ` ${JSON.stringify(details)}`;
}

function sanitizeForLog(value: unknown): unknown {
	return sanitizeValue(value, new WeakSet<object>());
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack
		};
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(item, seen));
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	if (seen.has(value)) {
		return "[Circular]";
	}

	seen.add(value);

	const result: Record<string, unknown> = {};

	for (const [key, item] of Object.entries(value)) {
		result[key] = isSensitiveKey(key) ? "[REDACTED]" : sanitizeValue(item, seen);
	}

	seen.delete(value);

	return result;
}

function isSensitiveKey(key: string) {
	const normalizedKey = key.toLowerCase();
	return normalizedKey.includes("password") ||
		normalizedKey.includes("token") ||
		normalizedKey.includes("secret") ||
		normalizedKey.includes("credential");
}
