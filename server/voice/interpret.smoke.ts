import assert from "node:assert/strict";
import { controlWord, interpret, parseClock, parseRelative, wordsToNumber, type InterpretContext } from "./interpret.js";

const ctx: InterpretContext = { utteredAt: new Date("2026-09-09T07:47:03Z"), tzMode: "utc", maxPastHours: 12 };
const ok = (r: ReturnType<typeof interpret>) => {
	assert.equal(r.ok, true, JSON.stringify(r));
	return r as Extract<typeof r, { ok: true }>;
};

export async function run(): Promise<void> {
	// numbers
	assert.equal(wordsToNumber("twenty point five"), 20.5);
	assert.equal(wordsToNumber("one hundred and twelve"), 112);
	assert.equal(wordsToNumber("42"), 42);
	assert.equal(wordsToNumber("3.5"), 3.5);
	assert.equal(wordsToNumber("minus four"), -4);
	assert.equal(wordsToNumber("banana"), undefined);

	// clock
	assert.deepEqual(parseClock("zero seven four two")?.h, 7);
	assert.deepEqual(parseClock("zero seven four two")?.min, 42);
	assert.deepEqual(parseClock("07:42")?.min, 42);
	assert.deepEqual(parseClock("0742")?.min, 42);
	assert.deepEqual(parseClock("half past seven"), { h: 7, min: 30, confidence: 0.85 });
	assert.deepEqual(parseClock("quarter to eight")?.min, 45);
	assert.deepEqual(parseClock("seven forty two")?.min, 42);
	assert.equal(parseClock("when we passed the buoy"), undefined);

	// relative
	assert.equal(parseRelative("five minutes ago", ctx)?.at.toISOString(), "2026-09-09T07:42:03.000Z");
	assert.equal(parseRelative("half an hour ago", ctx)?.at.toISOString(), "2026-09-09T07:17:03.000Z");
	assert.equal(parseRelative("now", ctx)?.at.toISOString(), ctx.utteredAt.toISOString());
	assert.equal(parseRelative("two days ago", ctx), undefined);
	assert.ok((parseRelative("fourteen hours ago", ctx)?.confidence ?? 1) < 0.5, "beyond the plausibility window");

	// DateAndTime: the spec's worked example
	const pilot = ok(interpret("DateAndTime", "Pilot on board five minutes ago.", ctx, ["pilot on board"]));
	assert.equal(pilot.value, "2026-09-09T07:42:03.000Z");
	assert.equal(pilot.valueText, "07:42 UTC");
	const engine = ok(interpret("DateAndTime", "Engine started.", ctx, ["engine started"]));
	assert.equal(engine.kind, "now");
	// Appendix A: said at 08:14, "at zero eight zero five" resolves to 08:05 today; utteredAt stays 08:14
	const later: InterpretContext = { ...ctx, utteredAt: new Date("2026-09-09T08:14:00Z") };
	const at = ok(interpret("DateAndTime", "at zero eight zero five", later));
	assert.equal(at.value, "2026-09-09T08:05:00.000Z");
	assert.equal(at.valueText, "08:05 UTC");
	// a clock time in the future (by more than 5 min) rolls back a day and is then implausible → clarify
	const future = interpret("DateAndTime", "at zero eight zero five", ctx);
	assert.equal(future.ok, false);
	assert.equal((future as { reason: string }).reason, "implausible");
	const buoy = interpret("DateAndTime", "when we passed the buoy", ctx);
	assert.equal(buoy.ok, false);
	const old = interpret("DateAndTime", "fourteen hours ago", ctx);
	assert.equal(old.ok, false);
	assert.equal((old as { reason: string }).reason, "implausible");

	// Checkbox
	assert.equal(ok(interpret("Checkbox", "affirmative", ctx)).value, "true");
	assert.equal(ok(interpret("Checkbox", "Yes.", ctx)).value, "true");
	assert.equal(ok(interpret("Checkbox", "nope", ctx)).value, "false");
	assert.equal(interpret("Checkbox", "maybe", ctx).ok, false);

	// QuickSelect bounded to the option set
	const opts = { ...ctx, options: [{ title: "Yes", value: "Yes" }, { title: "No", value: "No" }, { title: "Not applicable", value: "N/A" }] };
	assert.equal(ok(interpret("QuickSelect", "not applicable", opts)).value, "N/A");
	assert.equal(ok(interpret("QuickSelect", "N A", opts)).value, "N/A");
	assert.equal(ok(interpret("QuickSelect", "yes", opts)).value, "Yes");
	assert.equal(ok(interpret("QuickSelect", "option three", opts)).value, "N/A");
	assert.equal(interpret("QuickSelect", "purple", opts).ok, false);
	const bilge = { ...ctx, options: [{ title: "Normal", value: "Normal" }, { title: "High", value: "High" }, { title: "Alarm", value: "Alarm" }] };
	assert.equal(ok(interpret("QuickSelect", "normal", bilge)).value, "Normal");
	assert.equal(ok(interpret("QuickSelect", "it's high", bilge)).value, "High");

	// Number with units
	assert.equal(ok(interpret("Number", "twenty point five degrees", ctx)).value, "20.5");
	assert.equal(ok(interpret("Number", "7.2 meters", ctx)).value, "7.2");

	// Time / Date
	assert.equal(ok(interpret("Time", "zero seven four two", ctx)).value, "07:42");
	assert.equal(ok(interpret("Date", "yesterday", ctx)).value, "2026-09-08");
	assert.equal(ok(interpret("Date", "the ninth of September", ctx)).value, "2026-09-09");

	// control vocabulary
	assert.equal(controlWord("Confirmed."), "confirm");
	assert.equal(controlWord("yes"), "confirm");
	assert.equal(controlWord("No"), "no");
	assert.equal(controlWord("say again"), "repeat");
	assert.equal(controlWord("skip"), "skip");
	assert.equal(controlWord("where am I?"), "where");
	assert.equal(controlWord("how many left"), "remaining");
	assert.equal(controlWord("pilot on board five minutes ago"), undefined);

	// local time mode with a zone
	const local: InterpretContext = { ...ctx, tzMode: "local", timeZone: "Europe/Oslo" };
	const l = ok(interpret("DateAndTime", "at zero nine four two", local));
	assert.equal(l.value, "2026-09-09T07:42:00.000Z", "09:42 Oslo (CEST) = 07:42 UTC");
	assert.equal(l.valueText, "09:42 local time");
}
