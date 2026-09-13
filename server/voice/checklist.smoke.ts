import assert from "node:assert/strict";
import type { FlowDetail } from "../maranics/FlowsClient.js";
import { toFlowDetail } from "../maranics/FlowsClient.js";
import { buildItems, itemAnnouncement, nextItem, progressOf, readinessOf, spokenNumber, spokenPromptFor, startAnnouncement } from "./checklist.js";

function arrival(): FlowDetail {
	const raw = {
		flowId: "chk_8812",
		name: "Arrival Checklist",
		templateId: "NauticAI/ArrivalChecklist",
		status: "Active",
		sections: [
			{
				sectionId: "s1",
				name: "Pilot operations",
				order: 1,
				tasks: [
					{ taskId: "t2", name: "Pilot card exchanged", order: 2, controls: [{ controlId: "c2", dataId: "P/Card", type: "Checkbox" }], state: { status: "Open" }, values: [] },
					{ taskId: "t1", name: "Pilot on board", order: 1, controls: [{ controlId: "c1", dataId: "P/OnBoard", type: "DateAndTime" }], state: { status: "Done" }, values: [{ controlId: "c1", value: "2026-09-09T07:42:00Z" }] },
					{ taskId: "t3", name: "Master pilot exchange completed", order: 3, controls: [{ controlId: "c3", dataId: "P/Exchange", type: "QuickSelect", quickSelectValues: [{ title: "Yes", value: "Yes" }, { title: "N/A", value: "N/A" }] }], state: { status: "Open" } },
				],
			},
			{
				sectionId: "s2",
				name: "Sign off",
				order: 2,
				tasks: [
					{ taskId: "t4", name: "Master", order: 1, controls: [{ controlId: "c4", dataId: "S/Master", type: "Sign" }], state: { status: "Open" } },
					{ taskId: "t5", name: "Notice to crew", order: 2, controls: [{ controlId: "c5", type: "Information" }] },
				],
			},
		],
	};
	const d = toFlowDetail(raw);
	assert.ok(d);
	return d;
}

export async function run(): Promise<void> {
	const flow = arrival();
	assert.equal(flow.sections.length, 2);
	assert.equal(flow.tasks.length, 5);

	const items = buildItems(flow, { readNotices: false });
	assert.deepEqual(
		items.map((i) => i.taskId),
		["t1", "t2", "t3", "t4"],
		"template order: section order then task order; notices hidden",
	);
	assert.equal(items[0].state, "answered");
	assert.equal(items[0].valueText, "07:42 UTC");
	assert.equal(items[1].spokenPrompt, "Pilot card exchanged?");
	assert.equal(items[2].options?.length, 2);
	assert.equal(items[3].state, "needs_screen");
	assert.equal(items[3].voice, false);

	const r = readinessOf(items);
	assert.deepEqual(r, { readiness: "partial", needsScreen: 1, voiceTotal: 3, total: 4 });
	const p = progressOf(items);
	assert.equal(p.answered, 1);
	assert.equal(p.total, 4);

	assert.equal(nextItem(items)?.taskId, "t2", "resume, don't restart");
	assert.equal(nextItem(items, 2)?.taskId, "t3");
	assert.equal(nextItem(items, 3), undefined, "signature item is never spoken");

	const withNotices = buildItems(flow, { readNotices: true });
	assert.equal(withNotices.length, 5);
	assert.equal(withNotices[4].state, "info");

	assert.equal(spokenPromptFor("Pilot on board"), "Pilot on board?");
	assert.equal(spokenPromptFor("Is the pilot on board?"), "Is the pilot on board?");
	assert.equal(spokenNumber(22), "twenty-two");
	assert.equal(startAnnouncement("Arrival Checklist", items, "full", false), "Starting Arrival Checklist. four items, one needs the screen.");
	assert.equal(startAnnouncement("Arrival Checklist", items, "short", true), "Resuming Arrival Checklist.");
	assert.equal(startAnnouncement("Arrival Checklist", items, "silent", false), "");
	assert.equal(itemAnnouncement(items[1], undefined, true, "full"), "First section, Pilot operations. Item two. Pilot card exchanged?");
	assert.equal(itemAnnouncement(items[2], "Pilot operations", false, "short"), "Master pilot exchange completed?");

	// profile binding overrides the spoken prompt
	const bound = buildItems(flow, { readNotices: false, profile: { profileId: "p", name: "p", bindings: [{ bindingId: "b", dataId: "P/Card", spokenPrompt: "Has the pilot card been exchanged?" }] } });
	assert.equal(bound[1].spokenPrompt, "Has the pilot card been exchanged?");
}
