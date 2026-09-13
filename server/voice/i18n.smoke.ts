import assert from "node:assert/strict";
import { normLang, spokenNumber, t } from "./i18n.js";
import { controlWord, interpret, parseClock, parseRelative, wordsToNumber, type InterpretContext } from "./interpret.js";
import { startAnnouncement } from "./checklist.js";
import type { RunItem } from "../protocol.js";

const base: InterpretContext = { utteredAt: new Date("2026-09-09T07:47:03Z"), tzMode: "utc", maxPastHours: 12 };
const ok = (r: ReturnType<typeof interpret>) => {
	assert.equal(r.ok, true, JSON.stringify(r));
	return r as Extract<typeof r, { ok: true }>;
};

export async function run(): Promise<void> {
	assert.equal(normLang("nb-NO"), "no");
	assert.equal(normLang("sv-SE"), "sv");
	assert.equal(normLang("fr"), "fr");
	assert.equal(normLang("de-CH"), "de");
	assert.equal(normLang("xx"), "en");

	// numbers in words
	assert.equal(wordsToNumber("tjugofem"), 25);
	assert.equal(wordsToNumber("tjugo komma fem"), 20.5);
	assert.equal(wordsToNumber("førtito"), 42);
	assert.equal(wordsToNumber("siebenundvierzig"), 47);
	assert.equal(wordsToNumber("zwanzig komma fünf"), 20.5);
	assert.equal(wordsToNumber("vingt-deux"), 22);
	assert.equal(wordsToNumber("quatre-vingt-douze"), 92);
	assert.equal(wordsToNumber("soixante-dix"), 70);
	assert.equal(wordsToNumber("vingt virgule cinq"), 20.5);
	assert.equal(wordsToNumber("cent douze"), 112);

	// spoken numbers
	assert.equal(spokenNumber(22, "sv"), "tjugotvå");
	assert.equal(spokenNumber(22, "no"), "tjueto");
	assert.equal(spokenNumber(22, "de"), "zweiundzwanzig");
	assert.equal(spokenNumber(21, "de"), "einundzwanzig");
	assert.equal(spokenNumber(22, "fr"), "vingt-deux");
	assert.equal(spokenNumber(71, "fr"), "soixante et onze");
	assert.equal(spokenNumber(80, "fr"), "quatre-vingts");
	assert.equal(spokenNumber(9, "en"), "nine");

	// clocks
	assert.deepEqual(parseClock("halv åtta"), { h: 7, min: 30, confidence: 0.85 }, "Swedish halv åtta is 07:30");
	assert.deepEqual(parseClock("halb acht"), { h: 7, min: 30, confidence: 0.85 }, "German halb acht is 07:30");
	assert.deepEqual(parseClock("kvart över sju")?.min, 15);
	assert.deepEqual(parseClock("kvart på åtta"), { h: 7, min: 45, confidence: 0.8 });
	assert.deepEqual(parseClock("viertel vor acht"), { h: 7, min: 45, confidence: 0.8 });
	assert.deepEqual(parseClock("sept heures et demie"), { h: 7, min: 30, confidence: 0.85 });
	assert.deepEqual(parseClock("huit heures moins le quart"), { h: 7, min: 45, confidence: 0.8 });
	assert.deepEqual(parseClock("sept heures quarante-deux"), { h: 7, min: 42, confidence: 0.85 });
	assert.deepEqual(parseClock("sieben uhr zweiundvierzig"), { h: 7, min: 42, confidence: 0.85 });
	assert.deepEqual(parseClock("null sju førti to")?.min, 42);
	assert.deepEqual(parseClock("noll sju fyrtiotvå"), { h: 7, min: 42, confidence: 0.9 });
	assert.deepEqual(parseClock("klockan sju")?.h, 7);
	assert.deepEqual(parseClock("7h42")?.min, 42);

	// relative
	assert.equal(parseRelative("för fem minuter sedan", base)?.at.toISOString(), "2026-09-09T07:42:03.000Z");
	assert.equal(parseRelative("fem minutter siden", base)?.at.toISOString(), "2026-09-09T07:42:03.000Z");
	assert.equal(parseRelative("vor fünf minuten", base)?.at.toISOString(), "2026-09-09T07:42:03.000Z");
	assert.equal(parseRelative("il y a cinq minutes", base)?.at.toISOString(), "2026-09-09T07:42:03.000Z");
	assert.equal(parseRelative("il y a une demi-heure", base)?.at.toISOString(), "2026-09-09T07:17:03.000Z");
	assert.equal(parseRelative("nu", base)?.text, "now");
	assert.equal(parseRelative("maintenant", base)?.text, "now");
	assert.equal(parseRelative("jetzt", base)?.text, "now");

	// full interpretations per language, with read-back text in that language
	const sv = { ...base, language: "sv" };
	const pilot = ok(interpret("DateAndTime", "Lots ombord för fem minuter sedan", sv, ["lots ombord"]));
	assert.equal(pilot.value, "2026-09-09T07:42:03.000Z");
	assert.equal(pilot.valueText, "07:42 UTC");
	const de = { ...base, language: "de" };
	assert.equal(ok(interpret("DateAndTime", "Lotse an Bord vor zehn Minuten", de, ["lotse an bord"])).value, "2026-09-09T07:37:03.000Z");
	const fr = { ...base, language: "fr", tzMode: "local" as const, timeZone: "Europe/Paris" };
	const eng = ok(interpret("DateAndTime", "moteur démarré à neuf heures quarante-deux", fr, ["moteur démarré"]));
	assert.equal(eng.value, "2026-09-09T07:42:00.000Z");
	assert.equal(eng.valueText, "09:42 heure locale");
	const no = { ...base, language: "no" };
	assert.equal(ok(interpret("DateAndTime", "hovedmotor startet", no, ["hovedmotor startet"])).kind, "now");
	assert.match(ok(interpret("DateAndTime", "hovedmotor startet", no, ["hovedmotor startet"])).valueText, /^nå, /);

	// yes / no / N/A
	assert.equal(ok(interpret("Checkbox", "Ja", sv)).valueText, "ja");
	assert.equal(ok(interpret("Checkbox", "nej", sv)).value, "false");
	assert.equal(ok(interpret("Checkbox", "oui", fr)).valueText, "oui");
	assert.equal(ok(interpret("Checkbox", "non", fr)).value, "false");
	assert.equal(ok(interpret("Checkbox", "nein", de)).valueText, "nein");
	assert.equal(interpret("Checkbox", "kanske", sv).ok, false);
	assert.equal((interpret("Checkbox", "kanske", sv) as { message: string }).message, "Säg ja eller nej");
	const opts = [{ title: "Ja", value: "Yes" }, { title: "Nej", value: "No" }, { title: "Ej tillämpligt", value: "N/A" }];
	assert.equal(ok(interpret("QuickSelect", "ej tillämpligt", { ...sv, options: opts })).value, "N/A");
	assert.equal(ok(interpret("QuickSelect", "ikke aktuelt", { ...no, options: [{ title: "Ja", value: "Yes" }, { title: "Ikke aktuelt", value: "N/A" }] })).value, "N/A");
	assert.equal(ok(interpret("QuickSelect", "sans objet", { ...fr, options: [{ title: "Oui", value: "Yes" }, { title: "Sans objet", value: "N/A" }] })).value, "N/A");
	assert.equal(ok(interpret("QuickSelect", "nicht zutreffend", { ...de, options: [{ title: "Ja", value: "Yes" }, { title: "Nicht zutreffend", value: "N/A" }] })).value, "N/A");
	assert.equal(ok(interpret("QuickSelect", "alternativ två", { ...sv, options: opts })).value, "No");

	// numbers with units
	assert.equal(ok(interpret("Number", "tjugo komma fem grader", sv)).value, "20.5");
	assert.equal(ok(interpret("Number", "sieben komma zwei meter", de)).value, "7.2");
	assert.equal(ok(interpret("Number", "vingt virgule cinq degrés", fr)).value, "20.5");

	// dates
	assert.equal(ok(interpret("Date", "igår", sv)).value, "2026-09-08");
	assert.equal(ok(interpret("Date", "hier", fr)).value, "2026-09-08");
	assert.equal(ok(interpret("Date", "gestern", de)).value, "2026-09-08");
	assert.equal(ok(interpret("Date", "den nionde september", sv)).value, "2026-09-09");
	assert.equal(ok(interpret("Date", "niende september", no)).value, "2026-09-09");
	assert.equal(ok(interpret("Date", "am neunten september", de)).value, "2026-09-09");
	assert.equal(ok(interpret("Date", "le neuf septembre", fr)).value, "2026-09-09");
	assert.equal(ok(interpret("Date", "le 9 septembre 2026", fr)).value, "2026-09-09");

	// control words
	assert.equal(controlWord("Bekräfta"), "confirm");
	assert.equal(controlWord("bekreftet"), "confirm");
	assert.equal(controlWord("oui"), "confirm");
	assert.equal(controlWord("stimmt"), "confirm");
	assert.equal(controlWord("nej"), "no");
	assert.equal(controlWord("nein"), "no");
	assert.equal(controlWord("non"), "no");
	assert.equal(controlWord("säg igen"), "repeat");
	assert.equal(controlWord("gjenta"), "repeat");
	assert.equal(controlWord("wiederholen"), "repeat");
	assert.equal(controlWord("répéter"), "repeat");
	assert.equal(controlWord("hoppa över"), "skip");
	assert.equal(controlWord("passer"), "skip");
	assert.equal(controlWord("überspringen"), "skip");
	assert.equal(controlWord("var är vi?"), "where");
	assert.equal(controlWord("wie viele noch"), "remaining");
	assert.equal(controlWord("combien il en reste"), "remaining");
	assert.equal(controlWord("starta"), "start");
	assert.equal(controlWord("commencer"), "start");
	assert.equal(controlWord("fortsett"), "resume");

	// announcements
	const items: RunItem[] = [
		{ taskId: "a", index: 1, name: "Lots ombord", spokenPrompt: "Lots ombord?", type: "DateAndTime", voice: true, state: "unanswered" },
		{ taskId: "b", index: 2, name: "Signatur", spokenPrompt: "Signatur?", type: "Sign", voice: false, state: "needs_screen" },
	];
	assert.equal(startAnnouncement("Ankomstchecklista", items, "full", false, "sv"), "Startar Ankomstchecklista. två punkter, en kräver skärmen.");
	assert.equal(startAnnouncement("Ankomstsjekkliste", items, "full", false, "no"), "Starter Ankomstsjekkliste. to punkter, ett krever skjermen.");
	assert.equal(startAnnouncement("Liste d'arrivée", items, "full", false, "fr"), "Début de Liste d'arrivée. deux points, un nécessite l'écran.");
	assert.equal(startAnnouncement("Ankunftscheckliste", items, "full", false, "de"), "Starte Ankunftscheckliste. zwei Punkte, einer braucht den Bildschirm.");
	assert.equal(t("fr", "readback", { name: "Pilote à bord", value: "07:42 UTC" }), "Pilote à bord, 07:42 UTC. Confirmez ?");
	assert.equal(t("de", "ready", { name: "Ankunftscheckliste" }), "Ankunftscheckliste ist bereit. Sagen Sie Start, oder öffnen Sie sie am Bildschirm.");
}
