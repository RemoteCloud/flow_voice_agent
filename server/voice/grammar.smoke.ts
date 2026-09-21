import assert from "node:assert/strict";
import { grammarFor } from "./grammar.js";

export function run(): void {
	const cb = grammarFor("no", { type: "Checkbox", name: "Ladeplugg i garasje — Verifiseres" });
	assert.ok(cb && cb.includes("ja") && cb.includes("yes") && cb.includes("utført") && cb.includes("skip"), "yes/no + control words in English and the run language");
	assert.ok(!cb.includes("minutter siden"), "no time phrases on a checkbox");
	assert.ok(cb.includes("ladeplugg i garasje — verifiseres"), "the item name is allowed (unprompted answer / read-back repeat)");

	const t = grammarFor("sv", { type: "DateAndTime", name: "Pilot on board" });
	assert.ok(t && t.includes("minuter sedan") && t.includes("fyrtio") && t.includes("minutes ago") && t.includes("now"), "time and number words");

	const q = grammarFor("en", { type: "QuickSelect", name: "Bilge", options: [{ title: "Normal", value: "Normal" }, { title: "High", value: "High" }] }, ["bilge level"]);
	assert.ok(q && q.includes("normal") && q.includes("high") && q.includes("bilge level"), "options and bound phrases");

	assert.equal(grammarFor("en", { type: "Text", name: "Remarks" }), undefined, "free text needs open dictation");
	const c = grammarFor("de", { type: "Number", name: "Draft" }, [], true);
	assert.ok(c && c.includes("bestätigen") && !c.includes("vierzig"), "confirm window: control words only");
}
