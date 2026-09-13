/**
 * Console logger with level filter and ISO timestamps. Every argument goes through `redact()`,
 * so registered secrets (Maranics token, HUB_SECRET, SESSION_SECRET, MQTT/UI passwords) and any
 * `Bearer …` are masked. Never log deck tokens, cookies or request bodies.
 */
import { redact } from "./redact.js";
import type { LogLevel } from "../env.js";

export interface Logger {
	debug(msg: string, ...rest: unknown[]): void;
	info(msg: string, ...rest: unknown[]): void;
	warn(msg: string, ...rest: unknown[]): void;
	error(msg: string, ...rest: unknown[]): void;
}

export interface LogSink {
	out(line: string): void;
	err(line: string): void;
}

const RANK: Record<LogLevel | "error", number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(level: LogLevel, sink: LogSink = { out: (l) => console.log(l), err: (l) => console.error(l) }, now: () => Date = () => new Date()): Logger {
	const min = RANK[level];
	const line = (lvl: LogLevel | "error", msg: string, rest: unknown[]) => `${now().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${[msg, ...rest].map(redact).join(" ")}`;
	const emit = (lvl: LogLevel | "error", msg: string, rest: unknown[]) => {
		if (RANK[lvl] < min) return;
		const text = line(lvl, msg, rest);
		if (lvl === "error" || lvl === "warn") sink.err(text);
		else sink.out(text);
	};
	return {
		debug: (msg, ...rest) => emit("debug", msg, rest),
		info: (msg, ...rest) => emit("info", msg, rest),
		warn: (msg, ...rest) => emit("warn", msg, rest),
		error: (msg, ...rest) => emit("error", msg, rest),
	};
}

/** For smoke tests and optional deps. */
export const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
