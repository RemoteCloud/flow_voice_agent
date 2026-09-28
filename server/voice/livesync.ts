/**
 * Live sync with the Flow app: what changed in Maranics under an open run (someone ticked an item on
 * a phone, a workflow wrote a value) and what the voice must do about it. Pure — no I/O, no timers.
 * The watching itself is `FlowWatcher.ts`; applying a diff is `RunEngine.applyExternal`.
 *
 * The cheap read behind it is `GET /flows/{flowId}/values` (one row per control, `fields` picks the
 * columns, `pageSize=0` returns stats only). So a run is watched with a few hundred bytes per tick and
 * only pulls rows once the stats move.
 *
 * Everything the hub itself wrote is off limits here: an item whose value sits in the outbox
 * (`unsynced`) belongs to `Outbox`, never to a poll that raced it.
 */
import type { FlowValueRow, FlowValueStats } from "../maranics/FlowsClient.js";
import type { RunItem } from "../protocol.js";

/** A row of the flat value query, and the stats of the same read. Names kept short for this module. */
export type ValueRow = FlowValueRow;
export type FlowStats = FlowValueStats;

export type ExternalKind =
	/** Unanswered (or skipped) here, answered in Flow. */
	| "answered"
	/** Answered on both sides, different values. */
	| "changed"
	/** Answered here, the value is gone in Flow. */
	| "reopened";

export interface ExternalChange {
	taskId: string;
	dataId?: string;
	name: string;
	index: number;
	kind: ExternalKind;
	value?: string;
	valueText?: string;
	/** When Flow recorded it. */
	at?: string;
	/** The value the hub held before (for the audit record). */
	was?: string;
}

export interface ExternalDiff {
	changes: ExternalChange[];
	/**
	 * Flow returned a task this run does not know: a task was added (or the visibility rules opened a
	 * section) while the run was open. The item list itself has to be rebuilt — a value diff cannot do it.
	 */
	structureChanged: boolean;
}

const DONE = new Set(["Done", "Overridden"]);

/** A row carries an answer when it has a value, or Flow marked the task done without one. */
export function rowAnswered(row: ValueRow): boolean {
	if (row.value !== undefined && row.value !== "") return true;
	return DONE.has(row.status ?? "");
}

/**
 * Display form of a value that came from Flow. Mirrors `committedValueText` in `checklist.ts` (kept
 * separate: that one reads a whole `TaskDetail`, this one a flat row) and prefers Flow's own label.
 */
export function rowValueText(row: ValueRow): string | undefined {
	const raw = row.displayValue !== undefined && row.displayValue !== "" ? row.displayValue : row.value;
	if (raw === undefined || raw === "") return DONE.has(row.status ?? "") ? (row.status === "Overridden" ? "overridden" : "done") : undefined;
	if (raw === "true") return "yes";
	if (raw === "false") return "no";
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return `${raw.slice(11, 16)} UTC`;
	return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
}

/** Same answer, written either side? Empty and absent are the same thing; case and padding never matter. */
export function sameValue(a: string | undefined, b: string | undefined): boolean {
	const n = (v: string | undefined) => (v ?? "").trim().toLowerCase();
	return n(a) === n(b);
}

/** Has anything moved at all? Compared against the stats of the previous tick (none → yes, read the rows). */
export function statsMoved(prev: FlowStats | undefined, now: FlowStats): boolean {
	if (!prev) return true;
	return prev.matched !== now.matched || prev.withValue !== now.withValue || prev.overridden !== now.overridden;
}

/**
 * What Flow says versus what this run holds. Items the hub is still writing (`unsynced`) are left alone;
 * an item Flow does not mention (hidden by a visibility rule, or not voice-eligible and never read) is
 * left alone too — only a task Flow knows and the run does not counts as a structure change.
 */
export function diffExternal(items: RunItem[], rows: ValueRow[]): ExternalDiff {
	const byTask = new Map<string, ValueRow>();
	const byData = new Map<string, ValueRow>();
	for (const r of rows) {
		if (r.taskId && !byTask.has(r.taskId)) byTask.set(r.taskId, r);
		// a form control expands to one row per input: the first row that holds an answer speaks for the task
		else if (r.taskId && rowAnswered(r) && !rowAnswered(byTask.get(r.taskId)!)) byTask.set(r.taskId, r);
		if (r.dataId && !byData.has(r.dataId)) byData.set(r.dataId, r);
	}

	const known = new Set<string>();
	const changes: ExternalChange[] = [];
	for (const item of items) {
		if (item.state === "info") continue;
		const row = byTask.get(item.taskId) ?? (item.dataId ? byData.get(item.dataId) : undefined);
		if (!row) continue;
		known.add(row.taskId);
		if (item.state === "unsynced") continue; // the hub's own write is in flight — the outbox owns this item
		if (item.reasking) continue; // the hub is asking this one again on purpose: the value in Flow must not steal it

		const answered = rowAnswered(row);
		const mine = item.state === "answered";
		if (answered) {
			if (mine && sameValue(item.value, row.value)) continue;
			changes.push({
				taskId: item.taskId,
				dataId: item.dataId,
				name: item.name,
				index: item.index,
				kind: mine ? "changed" : "answered",
				value: row.value,
				valueText: rowValueText(row),
				at: row.time,
				was: mine ? item.value : undefined,
			});
		} else if (mine) {
			changes.push({ taskId: item.taskId, dataId: item.dataId, name: item.name, index: item.index, kind: "reopened", was: item.value });
		}
	}

	const seen = new Set(items.map((i) => i.taskId));
	const structureChanged = rows.some((r) => r.taskId && !seen.has(r.taskId) && !known.has(r.taskId));
	return { changes, structureChanged };
}
