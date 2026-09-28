import type { ReactNode } from "react";
import type { ExchangeState, RunState } from "../../../server/protocol.js";

/** Inline message box. `danger` for something that failed, `warn` for something to look at, `info` for a note, `ok` for done. */
export function Alert({ tone = "danger", title, children, className = "" }: { tone?: "danger" | "warn" | "info" | "ok"; title?: string; children?: ReactNode; className?: string }) {
	if (!title && !children) return null;
	const cls = { danger: "border-danger/40 bg-danger/10 text-danger", warn: "border-warn/40 bg-warn/10 text-warn", info: "border-info/40 bg-info/10 text-info", ok: "border-ok/40 bg-ok/10 text-ok" }[tone];
	return (
		<div role={tone === "danger" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${cls} ${className}`}>
			{title && <p className="font-medium">{title}</p>}
			{children && <div className={title ? "mt-0.5 text-fg-muted" : ""}>{children}</div>}
		</div>
	);
}

export type SaveState = "idle" | "saving" | "saved" | "dirty";

/** "Saving… / Saved ✓ / Not saved yet" for screens that save at once, without a Save button. */
export function SaveMark({ state, className = "" }: { state: SaveState; className?: string }) {
	const text = state === "saving" ? "Saving…" : state === "dirty" ? "Not saved yet" : state === "saved" ? "Saved ✓" : "";
	return (
		<span className={`text-xs ${state === "saved" ? "text-ok" : "text-fg-faint"} ${className}`} aria-live="polite">
			{text}
		</span>
	);
}

/** What a run's state is called on screen. */
export const RUN_STATE_TEXT: Record<RunState, string> = { pending: "Waiting to start", active: "Running", paused: "Paused", completed: "Completed", abandoned: "Stopped" };

/** What the hub is doing right now in a run, in plain words. */
export const EXCHANGE_TEXT: Record<ExchangeState, string> = { idle: "", speaking: "speaking", listening: "listening", interpreting: "thinking", confirming: "waiting for confirm", committing: "saving", clarifying: "asking again", escalated: "needs the screen", waiting: "holding the next item" };

/** "a, b and c" without repeats. */
export function joinNames(users: { sub: string; name?: string }[]): string {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const u of users) {
		const n = u.name ?? u.sub;
		if (seen.has(n)) continue;
		seen.add(n);
		names.push(n);
	}
	return names.join(", ");
}

/** "1 station", "2 stations". */
export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}
