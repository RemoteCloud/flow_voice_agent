import assert from "node:assert/strict";
import type { RunItem } from "../protocol.js";
import { diffExternal, rowAnswered, rowValueText, sameValue, statsMoved, type ValueRow } from "./livesync.js";

function item(p: Partial<RunItem> & { taskId: string; index: number }): RunItem {
	return {
		dataId: p.dataId,
		name: p.name ?? `Item ${p.index}`,
		spokenPrompt: `${p.name ?? `Item ${p.index}`}?`,
		type: p.type ?? "Checkbox",
		voice: p.voice ?? true,
		state: p.state ?? "unanswered",
		value: p.value,
		valueText: p.valueText,
		...p,
	};
}

export async function run(): Promise<void> {
	// ---- rows
	assert.equal(rowAnswered({ taskId: "t1", value: "true" }), true);
	assert.equal(rowAnswered({ taskId: "t1", value: "" }), false);
	assert.equal(rowAnswered({ taskId: "t1", status: "Done" }), true);
	assert.equal(rowAnswered({ taskId: "t1", status: "Overridden" }), true);
	assert.equal(rowAnswered({ taskId: "t1", status: "Open" }), false);
	// a checkbox "false" IS an answer (Flow counts it as a value)
	assert.equal(rowAnswered({ taskId: "t1", value: "false" }), true);

	assert.equal(rowValueText({ taskId: "t", value: "true" }), "yes");
	assert.equal(rowValueText({ taskId: "t", value: "false" }), "no");
	assert.equal(rowValueText({ taskId: "t", value: "2026-09-24T07:42:00Z" }), "07:42 UTC");
	assert.equal(rowValueText({ taskId: "t", value: "3", displayValue: "Severe" }), "Severe");
	assert.equal(rowValueText({ taskId: "t", status: "Done" }), "done");
	assert.equal(rowValueText({ taskId: "t", status: "Overridden" }), "overridden");
	assert.equal(rowValueText({ taskId: "t", status: "Open" }), undefined);
	assert.equal(rowValueText({ taskId: "t", value: "x".repeat(60) })?.length, 41);

	assert.ok(sameValue("Up", " up "));
	assert.ok(sameValue(undefined, ""));
	assert.ok(!sameValue("true", "false"));

	// ---- stats gate
	assert.ok(statsMoved(undefined, { matched: 5, withValue: 0, overridden: 0 }));
	assert.ok(!statsMoved({ matched: 5, withValue: 2, overridden: 0 }, { matched: 5, withValue: 2, overridden: 0 }));
	assert.ok(statsMoved({ matched: 5, withValue: 2, overridden: 0 }, { matched: 5, withValue: 3, overridden: 0 }));
	assert.ok(statsMoved({ matched: 5, withValue: 2, overridden: 0 }, { matched: 5, withValue: 2, overridden: 1 }));
	assert.ok(statsMoved({ matched: 5, withValue: 2, overridden: 0 }, { matched: 6, withValue: 2, overridden: 0 }));

	// ---- answered in the Flow app while the run holds it open
	const items = [
		item({ taskId: "t1", index: 1, dataId: "P/OnBoard", name: "Pilot on board", type: "DateAndTime" }),
		item({ taskId: "t2", index: 2, dataId: "P/Ramp", name: "Ramp", state: "answered", value: "true", valueText: "yes" }),
		item({ taskId: "t3", index: 3, dataId: "P/Card", name: "Pilot card", state: "unsynced", value: "true" }),
		item({ taskId: "t4", index: 4, dataId: "P/Note", name: "Notice", type: "Information", voice: false, state: "info" }),
		item({ taskId: "t5", index: 5, dataId: "P/Sign", name: "Master", type: "Sign", voice: false, state: "needs_screen" }),
		item({ taskId: "t6", index: 6, dataId: "P/Vts", name: "VTS called", state: "skipped" }),
	];
	const rows: ValueRow[] = [
		{ taskId: "t1", dataId: "P/OnBoard", status: "Done", value: "2026-09-24T07:42:00Z", time: "2026-09-24T07:42:03Z" },
		{ taskId: "t2", dataId: "P/Ramp", status: "Done", value: "true" },
		{ taskId: "t3", dataId: "P/Card", status: "Open" },
		{ taskId: "t4", dataId: "P/Note", status: "Open" },
		{ taskId: "t5", dataId: "P/Sign", status: "Done", value: "signed" },
		{ taskId: "t6", dataId: "P/Vts", status: "Done", value: "true" },
	];
	const d = diffExternal(items, rows);
	assert.equal(d.structureChanged, false);
	const byTask = new Map(d.changes.map((c) => [c.taskId, c]));
	// t1 answered in the app
	assert.equal(byTask.get("t1")?.kind, "answered");
	assert.equal(byTask.get("t1")?.valueText, "07:42 UTC");
	assert.equal(byTask.get("t1")?.at, "2026-09-24T07:42:03Z");
	// t2 same value on both sides → nothing
	assert.equal(byTask.has("t2"), false);
	// t3 is ours and in flight → never touched by a poll
	assert.equal(byTask.has("t3"), false);
	// t4 is a notice → never
	assert.equal(byTask.has("t4"), false);
	// t5 needed the screen and got it in the app
	assert.equal(byTask.get("t5")?.kind, "answered");
	// t6 was skipped here and answered there: the answer wins over the skip
	assert.equal(byTask.get("t6")?.kind, "answered");
	assert.equal(d.changes.length, 3);

	// ---- value edited in the app after the voice wrote it
	const edited = diffExternal([item({ taskId: "t2", index: 1, name: "Ramp", state: "answered", value: "true", valueText: "yes" })], [{ taskId: "t2", status: "Done", value: "false" }]);
	assert.equal(edited.changes[0]?.kind, "changed");
	assert.equal(edited.changes[0]?.valueText, "no");
	assert.equal(edited.changes[0]?.was, "true");

	// ---- cleared in the app
	const cleared = diffExternal([item({ taskId: "t2", index: 1, name: "Ramp", state: "answered", value: "true" })], [{ taskId: "t2", status: "Open" }]);
	assert.equal(cleared.changes[0]?.kind, "reopened");
	assert.equal(cleared.changes[0]?.was, "true");
	assert.equal(cleared.changes[0]?.value, undefined);

	// ---- matched by DataId when the task id changed under us
	const byDataId = diffExternal([item({ taskId: "old", index: 1, dataId: "P/Ramp", name: "Ramp" })], [{ taskId: "new", dataId: "P/Ramp", status: "Done", value: "true" }]);
	assert.equal(byDataId.changes[0]?.kind, "answered");
	assert.equal(byDataId.changes[0]?.taskId, "old", "the change is reported on the run's own item");
	assert.equal(byDataId.structureChanged, false, "the row was consumed by DataId, so it is not a new task");

	// ---- a task added in the app: a value diff cannot place it, the item list must be rebuilt
	const grown = diffExternal([item({ taskId: "t1", index: 1, name: "One" })], [
		{ taskId: "t1", status: "Open" },
		{ taskId: "t9", dataId: "P/New", status: "Open" },
	]);
	assert.equal(grown.structureChanged, true);
	assert.equal(grown.changes.length, 0);

	// ---- a form control expands to several rows; the one holding the answer speaks for the task
	const form = diffExternal([item({ taskId: "t7", index: 1, name: "Bunker form", type: "Text" })], [
		{ taskId: "t7", dataId: "B/one", status: "Open" },
		{ taskId: "t7", dataId: "B/two", status: "Done", value: "42" },
	]);
	assert.equal(form.changes[0]?.kind, "answered");
	assert.equal(form.changes[0]?.valueText, "42");

	// ---- an item the hub is asking again on purpose keeps its question, whatever Flow holds
	const reasked = diffExternal([item({ taskId: "t2", index: 1, dataId: "P/Ramp", name: "Ramp", state: "unanswered", value: "true", valueText: "yes", reasking: true })], [{ taskId: "t2", dataId: "P/Ramp", status: "Done", value: "true" }]);
	assert.equal(reasked.changes.length, 0, "a jump-to re-ask is never taken back by live sync");
	assert.equal(reasked.structureChanged, false, "the row still counts as known");

	// ---- an item Flow does not mention (hidden by a visibility rule) is left as it is
	const hidden = diffExternal([item({ taskId: "t1", index: 1, name: "One" }), item({ taskId: "t2", index: 2, name: "Two", state: "answered", value: "true" })], [{ taskId: "t1", status: "Open" }]);
	assert.equal(hidden.changes.length, 0);
	assert.equal(hidden.structureChanged, false);
}
