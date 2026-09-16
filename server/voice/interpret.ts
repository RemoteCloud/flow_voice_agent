/**
 * Value Interpreter: transcript → typed value for a Maranics control type (spec section 8 + 9).
 * Deterministic parsers only; every parse returns a confidence and the engine clarifies below the
 * per-type threshold instead of guessing. Pure and smoke-tested.
 *
 * Understands English, Swedish, Norwegian, French and German at once: crews mix languages and the
 * STT locale is only a hint. Messages back to the user come from i18n.ts in the run's language.
 */
import { normLang, t as tr, type Lang } from "./i18n.js";

export interface InterpretContext {
	/** Moment the capture window closed — the anchor for relative time expressions. */
	utteredAt: Date;
	/** Vessel setting: read-back and stored times in UTC or local time. */
	tzMode: "utc" | "local";
	timeZone?: string;
	maxPastHours: number;
	options?: { title: string; value: string }[];
	language?: string;
}

export type Interpretation =
	| { ok: true; value: string; valueText: string; confidence: number; kind: string }
	| { ok: false; reason: "no_match" | "ambiguous" | "implausible" | "empty"; message: string; confidence: number };

export type ControlKind = "DateAndTime" | "Time" | "Date" | "Number" | "Checkbox" | "QuickSelect" | "Dropdown" | "RadioButtons" | "Text" | "LongText";

/** What the Flow API stores for a checked plain checkbox (`TaskValueValidation.cs`: `val == "OK"`). */
export const CHECKBOX_CHECKED = "OK";
/**
 * What a "yes" writes for a checkbox: a checkbox authored with one option ("Utført::completed") stores that
 * option's key, a plain one stores "OK". Several options make it a multi-select (see `interpret`).
 */
export function checkboxCheckedValue(options: { title: string; value: string }[] | undefined): { value: string; title?: string } {
	return options?.length === 1 ? { value: options[0].value, title: options[0].title } : { value: CHECKBOX_CHECKED };
}
/** A spoken "no" on a plain checkbox: nothing to write, the item stays open. */
export const CHECKBOX_NOT_DONE = "";

export const THRESHOLDS: Record<string, number> = { DateAndTime: 0.6, Time: 0.6, Date: 0.6, Number: 0.7, Checkbox: 0.7, QuickSelect: 0.6, Dropdown: 0.6, RadioButtons: 0.6, Text: 0.3, LongText: 0.1 };

// ---------------------------------------------------------------- control vocabulary (all languages)

export type ControlWord = "list" | "help" | "confirm" | "no" | "correction" | "repeat" | "skip" | "cancel" | "louder" | "slower" | "next" | "back" | "pause" | "stop" | "resume" | "where" | "remaining" | "start" | "complete" | "discard" | "manual";

const CONTROL: [RegExp, ControlWord][] = [
	[/^(list|checklists|list checklists|what can i run|which checklists|lista|checklistor|liste|sjekklister|liste des listes|quelles listes|checklisten|welche checklisten)$/i, "list"],
	[/^(help|what can i say|hjälp|hjelp|aide|hilfe|was kann ich sagen)$/i, "help"],
	[/^(confirm(ed)?|yes|yep|yeah|yup|correct|affirmative|roger|ok(ay)?|that'?s right|right|good|fine|sure|ja|jo|jepp|japp|jaha|jada|javisst|okej|okay|ok[eé]|greit|stemmer|det stemmer|riktig|precis|stämmer|det stämmer|bekreft(et)?|bekräfta(t)?|bekräftar|stimmt|richtig|bestätigt?|bestätige|genau|jawohl|passt|korrekt|oui|ouais|d'accord|confirm[ée]|exact|c'est ça|c'est bon|affirmatif|voilà|très bien)$/i, "confirm"],
	[/^(no|nope|negative|wrong|incorrect|nei|nej|nein|falsch|feil|fel|non|négatif|faux|nicht richtig)$/i, "no"],
	[/^(correction|correct that|change that|redo|rett|rettelse|ändra|rättelse|korrektur|korrigieren|ändern|corriger|changer|modifier)$/i, "correction"],
	[/^(say again|repeat|again|pardon|what|gjenta|si igjen|igjen|upprepa|säg igen|igen|wiederholen|nochmal|wie bitte|répéter|répète|encore|comment)$/i, "repeat"],
	[/^(skip|skip (it|this|that)|later|hopp over|hoppa över|überspringen|passer|sauter|passe)$/i, "skip"],
	[/^(cancel|abort|avbryt|abbrechen|annuler)$/i, "cancel"],
	[/^(louder|høyere|högre|lauter|plus fort)$/i, "louder"],
	[/^(slower|saktere|långsammare|langsamer|plus lentement|moins vite)$/i, "slower"],
	[/^(next|next item|next one|move on|neste|neste punkt|nästa|nästa punkt|gå vidare|weiter|nächster|nächster punkt|suivant|point suivant|continuer)$/i, "next"],
	[/^(back|go back|previous|tilbake|forrige|tillbaka|föregående|zurück|vorheriger|retour|précédent)$/i, "back"],
	[/^(pause|hold on|pause the run|vent|paus|pausiere|attends|attendez)$/i, "pause"],
	[/^(resume|continue|fortsett|fortsätt|weitermachen|fortfahren|reprendre|continuer|reprends)$/i, "resume"],
	[/^(stop|stop the run|end|stopp|stoppa|stoppe|anhalten|beenden|arrêter|arrête)$/i, "stop"],
	[/^(where am i|where are we|which item|hvor er vi|hvor er jeg|var är vi|var är jag|wo sind wir|wo bin ich|où en sommes-nous|où en est-on|on en est où)\??$/i, "where"],
	[/^(how many (are )?left|remaining|how many remaining|hvor mange igjen|hur många kvar|hur många är kvar|wie viele noch|wie viele übrig|combien (il en )?reste|combien restent)\??$/i, "remaining"],
	[/^(start|begin|start the checklist|start checklist|go|kjør|starta|börja|sett i gang|starten|los|commencer|commence|démarrer)$/i, "start"],
	[/^(complete|complete the checklist|finish|finish the checklist|fullfør|slutför|abschließen|fertig|terminer|finir)$/i, "complete"],
	[/^(discard|discard this checklist|discard the checklist|forkast|kassera|verwerfen|abandonner)$/i, "discard"],
	[/^(manual|manual entry|on screen|type it|screen|manuelt|manuell|på skjermen|på skärmen|am bildschirm|manuel|sur l'écran|à l'écran)$/i, "manual"],
];

export function normalizeTranscript(t: string): string {
	return t
		.toLowerCase()
		.replace(/[“”"’]/g, "'")
		.replace(/[.,!?;:]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * "item four", "go to item 4", "punkt fire", "gå til punkt 4", "Punkt vier", "point trois" → 4 / 3.
 * A jump target inside the active run (spoken item index); undefined when the phrase is anything else.
 */
export function itemNumber(transcript: string): number | undefined {
	const t = normalizeTranscript(transcript);
	const m = t.match(/^(?:(?:go|jump|gå|hopp|hoppa|geh|gehe|spring|aller|va|allez)\s+(?:to|til|till|zu|zum|au|à)\s+)?(?:item|point|punkt|post|élément|numéro|number|nummer)(?:\s+(?:number|nummer|numéro))?\s+(.+)$/);
	if (!m) return undefined;
	const n = wordsToNumber(m[1]);
	return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

export function controlWord(transcript: string): ControlWord | undefined {
	const t = normalizeTranscript(transcript);
	if (!t) return undefined;
	for (const [re, w] of CONTROL) if (re.test(t)) return w;
	return undefined;
}

// ---------------------------------------------------------------- numbers in words

const SMALL: Record<string, number> = {
	// en
	zero: 0, oh: 0, o: 0, nil: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
	twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
	// sv
	noll: 0, ett: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10, elva: 11, tolv: 12, tretton: 13, fjorton: 14, femton: 15, sexton: 16, sjutton: 17, arton: 18, nitton: 19,
	tjugo: 20, trettio: 30, fyrtio: 40, femtio: 50, sextio: 60, sjuttio: 70, åttio: 80, nittio: 90,
	// no
	null: 0, en: 1, to: 2, fire: 4, seks: 6, syv: 7, åtte: 8, ni: 9, ti: 10, elleve: 11, tretten: 13, fjorten: 14, femten: 15, seksten: 16, sytten: 17, atten: 18, nitten: 19,
	tjue: 20, tretti: 30, førti: 40, femti: 50, seksti: 60, sytti: 70, åtti: 80, nitti: 90,
	// de
	eins: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, dreizehn: 13, vierzehn: 14, fünfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19,
	zwanzig: 20, dreißig: 30, dreissig: 30, vierzig: 40, fünfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90,
	// fr
	zéro: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
	vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, "quatre-vingt": 80, "quatre-vingts": 80,
};
const SCALE: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, hundra: 100, tusen: 1000, hundre: 100, hundert: 100, tausend: 1000, cent: 100, cents: 100, mille: 1000 };

/** German compounds "siebenundvierzig" → 47, "zweihundert" → 200. */
function germanCompound(w: string): number | undefined {
	const m = w.match(/^(ein|eins|zwei|zwo|drei|vier|fünf|sechs|sieben|acht|neun)und(zwanzig|dreißig|dreissig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig)$/);
	if (m) return (m[1] === "ein" ? 1 : SMALL[m[1]]) + SMALL[m[2]];
	const h = w.match(/^(ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun)?hundert(.*)$/);
	if (h) {
		const rest = h[2] ? (SMALL[h[2]] ?? germanCompound(h[2])) : 0;
		if (rest === undefined) return undefined;
		return (h[1] ? (h[1] === "ein" ? 1 : SMALL[h[1]]) : 1) * 100 + rest;
	}
	return undefined;
}

/** Swedish / Norwegian compounds "tjugofem" / "tjuefem" → 25, "førtito" → 42. */
function nordicCompound(w: string): number | undefined {
	const m = w.match(/^(tjugo|trettio|fyrtio|femtio|sextio|sjuttio|åttio|nittio|tjue|tretti|førti|femti|seksti|sytti|åtti|nitti)(ett|en|två|to|tre|fyra|fire|fem|sex|seks|sju|syv|åtta|åtte|nio|ni)$/);
	if (m) return SMALL[m[1]] + SMALL[m[2]];
	return undefined;
}

function tokenValue(w: string): number | undefined {
	if (w in SMALL) return SMALL[w];
	return germanCompound(w) ?? nordicCompound(w);
}

/** "twenty point five" → 20.5, "vingt-deux" → 22, "siebenundvierzig" → 47, "tjugofem" → 25. Decimal separators: point / komma / virgule / dot. */
export function wordsToNumber(text: string): number | undefined {
	const t = normalizeTranscript(text)
		.replace(/\bquatre[ -]vingt(s)?\b/g, "quatre-vingt")
		.replace(/(?<!quatre)-/g, " ")
		.replace(/\b(and|och|og|et)\b/g, " ")
		.replace(/\b(minus|moins)\b/g, "negative")
		.replace(/\s+/g, " ")
		.trim();
	if (!t) return undefined;
	const direct = t.replace(/,/g, ".").match(/^(negative )?(\d+(?:\.\d+)?)$/);
	if (direct) return Number(direct[2]) * (direct[1] ? -1 : 1);
	const tokens = t.split(" ").filter(Boolean);
	let negative = false;
	if (tokens[0] === "negative") {
		negative = true;
		tokens.shift();
	}
	let total = 0;
	let current = 0;
	let seen = false;
	let i = 0;
	for (; i < tokens.length; i++) {
		const w = tokens[i];
		if (w === "point" || w === "komma" || w === "dot" || w === "virgule") break;
		if (/^\d+$/.test(w)) {
			current += Number(w);
			seen = true;
			continue;
		}
		const v = tokenValue(w);
		if (v !== undefined) {
			current += v;
			seen = true;
			continue;
		}
		if (w in SCALE) {
			const sc = SCALE[w];
			if (sc >= 1000) {
				total += (current || 1) * sc;
				current = 0;
			} else current = (current || 1) * sc;
			seen = true;
			continue;
		}
		return undefined;
	}
	if (!seen) return undefined;
	let value = total + current;
	if (i < tokens.length) {
		const frac = tokens.slice(i + 1);
		if (!frac.length) return undefined;
		let digits = "";
		for (const w of frac) {
			if (/^\d+$/.test(w)) digits += w;
			else {
				const v = tokenValue(w);
				if (v === undefined || v >= 100) return undefined;
				digits += String(v);
			}
		}
		value = Number(`${value}.${digits}`);
	}
	return negative ? -value : value;
}

function isDigitWord(w: string): boolean {
	return /^\d$/.test(w) || (w in SMALL && SMALL[w] < 10);
}
function digitOf(w: string): number {
	return /^\d$/.test(w) ? Number(w) : SMALL[w];
}

// ---------------------------------------------------------------- time

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function partsIn(d: Date, ctx: InterpretContext): { y: number; m: number; d: number; h: number; min: number } {
	if (ctx.tzMode === "utc") return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes() };
	if (ctx.timeZone) {
		const f = new Intl.DateTimeFormat("en-GB", { timeZone: ctx.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
		const p: Record<string, string> = {};
		for (const x of f.formatToParts(d)) p[x.type] = x.value;
		return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute) };
	}
	return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), min: d.getMinutes() };
}

/** Wall-clock (in the vessel's zone) → instant. */
function fromParts(p: { y: number; m: number; d: number; h: number; min: number }, ctx: InterpretContext): Date {
	if (ctx.tzMode === "utc") return new Date(Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, 0, 0));
	if (ctx.timeZone) {
		let guess = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
		for (let i = 0; i < 2; i++) {
			const q = partsIn(new Date(guess), ctx);
			const diff = Date.UTC(q.y, q.m - 1, q.d, q.h, q.min) - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
			guess -= diff;
		}
		return new Date(guess);
	}
	return new Date(p.y, p.m - 1, p.d, p.h, p.min, 0, 0);
}

export function formatClock(d: Date, ctx: InterpretContext): string {
	const p = partsIn(d, ctx);
	const lang = normLang(ctx.language);
	return `${pad(p.h)}:${pad(p.min)} ${ctx.tzMode === "utc" ? tr(lang, "utc") : tr(lang, "local_time")}`;
}

export function formatDate(d: Date, ctx: InterpretContext): string {
	const p = partsIn(d, ctx);
	return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

const HOUR_WORDS = /\b(at|kl|klokken|klokka|klockan|um|uhr|hours|o'clock|à|heures?|h)\b/g;
const MERIDIAN = /\b(pm|am|p\.m\.|a\.m\.|eftermiddag|på eftermiddagen|nachmittags|de l'après-midi|du soir|kveld|på kvelden|abends|på morgonen|morgens|du matin|om morgenen)\b/g;

/**
 * Spoken clock in five languages: "zero seven four two", "07 42", "7:42", "half past seven",
 * "quarter to eight", "halv åtta" (= 07:30 in Swedish/Norwegian!), "kvart över sju", "kvart på åtta",
 * "halb acht" (= 07:30), "viertel nach sieben", "viertel vor acht", "sept heures et demie",
 * "huit heures moins le quart", "sept heures quarante-deux".
 */
export function parseClock(text: string): { h: number; min: number; confidence: number } | undefined {
	let t = normalizeTranscript(text).replace(/-/g, " ").replace(/\bquatre vingt/g, "quatre-vingt");
	const pm = /\b(pm|p\.m\.|eftermiddag|på eftermiddagen|nachmittags|de l'après-midi|du soir|kveld|på kvelden|abends)\b/.test(t);
	const am = /\b(am|a\.m\.|på morgonen|morgens|du matin|om morgenen)\b/.test(t);
	t = t.replace(MERIDIAN, " ").replace(/\s+/g, " ").trim();
	const fix = (h: number, min: number, confidence: number) => {
		if (pm && h < 12) h += 12;
		if (am && h === 12) h = 0;
		return h < 24 && min < 60 ? { h, min, confidence } : undefined;
	};
	if (!t) return undefined;

	// digits: 07:42, 7.42, 0742, 7h42, 7 uhr 42
	let m = t.match(/^(?:at |kl |klokken |klokka |klockan |um |à )?(\d{1,2})(?:[:.h ]|\s*uhr\s*|\s*heures?\s*)(\d{2})(?:\s*uhr)?$/);
	if (m) return fix(Number(m[1]), Number(m[2]), 0.95);
	m = t.match(/^(?:at |kl |klockan |um |à )?(\d{1,2})\s*(?:uhr|heures?|h|o'clock)?$/);
	if (m) return fix(Number(m[1]), 0, 0.85);

	// Nordic / German "half to the NEXT hour": halv åtta / halb acht = 7:30
	m = t.match(/^(?:kl |klokken |klokka |klockan |um )?(?:halv|halb) (.+)$/);
	if (m) {
		const h = wordsToNumber(m[1]);
		if (h !== undefined && h >= 1 && h <= 24) return fix((h + 23) % 24, 30, 0.85);
	}
	// English "half past seven", French "sept heures et demie"
	m = t.match(/^(?:at )?half past (.+)$/) ?? t.match(/^(?:à )?(.+?) heures? et demie$/);
	if (m) {
		const h = wordsToNumber(m[1]);
		if (h !== undefined && h < 24) return fix(h, 30, 0.85);
	}
	// quarter past / kvart över / kvart over / viertel nach / et quart
	m = t.match(/^(?:at )?(?:a )?quarter past (.+)$/) ?? t.match(/^(?:kl |klockan |klokken )?kvart (?:över|over) (.+)$/) ?? t.match(/^(?:um )?viertel nach (.+)$/) ?? t.match(/^(?:à )?(.+?) heures? et quart$/);
	if (m) {
		const h = wordsToNumber(m[1]);
		if (h !== undefined && h < 24) return fix(h, 15, 0.8);
	}
	// quarter to / kvart i / kvart på / viertel vor / moins le quart
	m = t.match(/^(?:at )?(?:a )?quarter to (.+)$/) ?? t.match(/^(?:kl |klockan |klokken )?kvart (?:i|på) (.+)$/) ?? t.match(/^(?:um )?viertel vor (.+)$/) ?? t.match(/^(?:à )?(.+?) heures? moins le quart$/);
	if (m) {
		const h = wordsToNumber(m[1]);
		if (h !== undefined && h >= 1 && h <= 24) return fix((h + 23) % 24, 45, 0.8);
	}
	// N past H / N över H / N over H / N nach H
	m = t.match(/^(?:at |kl |klockan |klokken |um )?(.+?) (?:past|after|över|over|nach) (.+)$/);
	if (m) {
		const min = wordsToNumber(m[1]);
		const h = wordsToNumber(m[2]);
		if (min !== undefined && h !== undefined && min < 60 && h < 24) return fix(h, min, 0.75);
	}
	// N to H / N i H / N på H / N vor H · FR "H heures moins N"
	m = t.match(/^(?:at |kl |klockan |klokken |um )?(.+?) (?:to|before|i|på|vor) (.+)$/);
	if (!m) {
		const f = t.match(/^(?:à )?(.+?) heures? moins (.+)$/);
		if (f) m = [f[0], f[2], f[1]] as unknown as RegExpMatchArray;
	}
	if (m) {
		const min = wordsToNumber(m[1]);
		const h = wordsToNumber(m[2]);
		if (min !== undefined && h !== undefined && min < 60 && h >= 1 && h <= 24) return fix((h + 23) % 24, 60 - min, 0.75);
	}
	// French "sept heures quarante-deux", German "sieben uhr zweiundvierzig"
	m = t.match(/^(?:à |um )?(.+?) (?:heures?|uhr) (.+)$/);
	if (m) {
		const h = wordsToNumber(m[1]);
		const min = wordsToNumber(m[2]);
		if (h !== undefined && min !== undefined && h < 24 && min < 60) return fix(h, min, 0.85);
	}
	m = t.match(/^(?:à |um )?(.+?) (?:heures?|uhr)$/);
	if (m) {
		const h = wordsToNumber(m[1]);
		if (h !== undefined && h < 24) return fix(h, 0, 0.8);
	}
	// digit groups in any language: "zero seven four two", "null sju fire to", "null sieben vier zwei"
	const stripped = t.replace(HOUR_WORDS, " ").replace(/\s+/g, " ").trim();
	const tokens = stripped.replace(/(\d)(?=\d)/g, "$1 ").split(" ").filter(Boolean);
	const digits: number[] = [];
	let okDigits = tokens.length > 0;
	for (let k = 0; k < tokens.length; k++) {
		const w = tokens[k];
		if (isDigitWord(w)) digits.push(digitOf(w));
		else {
			const v = tokenValue(w);
			const next = tokens[k + 1];
			// "førti to" / "forty two" spoken as two words → one pair of digits
			if (v !== undefined && v >= 20 && v < 60 && v % 10 === 0 && next && isDigitWord(next) && digitOf(next) > 0) {
				digits.push(v / 10, digitOf(next));
				k++;
			} else if (v !== undefined && v >= 10 && v < 60) digits.push(Math.floor(v / 10), v % 10);
			else if (w === "hundred" || w === "hundra" || w === "hundre" || w === "hundert" || w === "cent") digits.push(0, 0);
			else {
				okDigits = false;
				break;
			}
		}
	}
	if (okDigits && digits.length === 4) {
		const r = fix(digits[0] * 10 + digits[1], digits[2] * 10 + digits[3], 0.9);
		if (r) return r;
	}
	if (okDigits && digits.length === 3) {
		const r = fix(digits[0], digits[1] * 10 + digits[2], 0.8);
		if (r) return r;
	}
	// "seven forty-two" / "sju fyrtiotvå" / "sieben zweiundvierzig": hour word then minute number
	m = stripped.match(/^(\S+) (.+)$/);
	if (m) {
		const h = wordsToNumber(m[1]);
		const min = wordsToNumber(m[2]);
		if (h !== undefined && min !== undefined && h < 24 && min < 60 && Number.isInteger(min)) return fix(h, min, 0.7);
	}
	const single = wordsToNumber(stripped);
	if (single !== undefined && Number.isInteger(single) && single >= 0 && single < 24) return fix(single, 0, 0.6);
	return undefined;
}

const UNIT_MS: Record<string, number> = {
	second: 1000, seconds: 1000, sec: 1000, secs: 1000, sekund: 1000, sekunder: 1000, sekunde: 1000, sekunden: 1000, seconde: 1000, secondes: 1000,
	minute: 60000, minutes: 60000, min: 60000, mins: 60000, minut: 60000, minuter: 60000, minutt: 60000, minutter: 60000, minuten: 60000,
	hour: 3600000, hours: 3600000, hr: 3600000, hrs: 3600000, timme: 3600000, timmar: 3600000, time: 3600000, timer: 3600000, stunde: 3600000, stunden: 3600000, heure: 3600000, heures: 3600000,
};
const UNIT_RE = "(seconds?|secs?|sekunde[rn]?|sekund|secondes?|minutes?|mins?|minuter|minut|minutt(?:er)?|minuten|hours?|hrs?|timmar|timme|timer?|stunden?|heures?)";
const ONE_WORDS = new Set(["a", "an", "one", "en", "ett", "ein", "eine", "einer", "un", "une"]);
const HALF_WORDS = /^(half an|half a|en halv|ein(?:e|er)? halbe?|une demi|un demi)$/;

/** Relative expressions anchored on `utteredAt`. Returns undefined when the text is not a time expression. */
export function parseRelative(text: string, ctx: InterpretContext): { at: Date; confidence: number; text: string } | undefined {
	const t = normalizeTranscript(text).replace(/demi-heure/g, "demi heure");
	if (/^(now|just now|right now|nå|akkurat nå|nu|precis nu|just nu|jetzt|gerade eben|soeben|maintenant|à l'instant|tout de suite)$/.test(t)) return { at: ctx.utteredAt, confidence: 0.95, text: "now" };
	// EN "N unit ago" · SV "för N unit sedan" · NO "for N unit siden" / "N unit siden" · DE "vor N unit" · FR "il y a N unit"
	const patterns = [
		new RegExp(`^(?:about |around |approximately |ca |circa |ungefär |omtrent |etwa |environ )?(.+?) ${UNIT_RE} ago$`),
		new RegExp(`^(?:för )?(.+?) ${UNIT_RE} (?:sedan|sen)$`),
		new RegExp(`^(?:for )?(.+?) ${UNIT_RE} siden$`),
		new RegExp(`^vor (?:etwa |ungefähr |circa )?(.+?) ${UNIT_RE}$`),
		new RegExp(`^il y a (?:environ )?(.+?) ${UNIT_RE}$`),
	];
	for (const re of patterns) {
		const m = t.match(re);
		if (!m) continue;
		const qty = m[1].trim();
		let n: number | undefined;
		if (ONE_WORDS.has(qty)) n = 1;
		else if (HALF_WORDS.test(qty)) n = 0.5;
		else n = wordsToNumber(qty);
		const unit = UNIT_MS[m[2]];
		if (n === undefined || !unit) return undefined;
		const ms = n * unit;
		if (ms > ctx.maxPastHours * 3600000) return { at: new Date(ctx.utteredAt.getTime() - ms), confidence: 0.2, text: t };
		return { at: new Date(ctx.utteredAt.getTime() - ms), confidence: 0.9, text: t };
	}
	if (/^(?:for )?half an hour ago$|^för en halvtimme sedan$|^en halvtimme sedan$|^for en halvtime siden$|^en halvtime siden$|^vor einer halben stunde$|^il y a une demi heure$/.test(t)) return { at: new Date(ctx.utteredAt.getTime() - 1800000), confidence: 0.9, text: t };
	if (/^(?:for )?(?:an?|one) hour ago$|^för en timme sedan$|^for en time siden$|^vor einer stunde$|^il y a une heure$/.test(t)) return { at: new Date(ctx.utteredAt.getTime() - 3600000), confidence: 0.9, text: t };
	return undefined;
}

/** A clock time today (or yesterday when the result would be in the future by more than 5 minutes). */
export function resolveClock(c: { h: number; min: number }, ctx: InterpretContext): Date {
	const now = partsIn(ctx.utteredAt, ctx);
	let at = fromParts({ ...now, h: c.h, min: c.min }, ctx);
	if (at.getTime() > ctx.utteredAt.getTime() + 5 * 60000) at = new Date(at.getTime() - 86400000);
	return at;
}

const DAY_WORDS: Record<string, number> = {
	today: 0, "i dag": 0, idag: 0, heute: 0, "aujourd'hui": 0,
	yesterday: -1, "i går": -1, igår: -1, gestern: -1, hier: -1,
	"day before yesterday": -2, "the day before yesterday": -2, "i forgårs": -2, "i förrgår": -2, förrgår: -2, vorgestern: -2, "avant-hier": -2,
};
const MONTHS: string[][] = [
	["january", "januari", "januar", "janvier", "jan"],
	["february", "februari", "februar", "février", "fevrier", "feb"],
	["march", "mars", "märz", "maerz", "mar"],
	["april", "avril", "apr"],
	["may", "maj", "mai"],
	["june", "juni", "juin", "jun"],
	["july", "juli", "juillet", "jul"],
	["august", "augusti", "août", "aout", "aug"],
	["september", "septembre", "sep", "sept"],
	["october", "oktober", "octobre", "okt", "oct"],
	["november", "novembre", "nov"],
	["december", "desember", "dezember", "décembre", "decembre", "dec", "des", "dez"],
];
function monthIndex(w: string): number {
	const x = w.replace(/\.$/, "");
	return MONTHS.findIndex((names) => names.includes(x) || names.some((n) => n.length >= 4 && x.length >= 3 && n.startsWith(x)));
}

const ORDINALS: Record<string, number> = {
	first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
	första: 1, andra: 2, tredje: 3, fjärde: 4, femte: 5, sjätte: 6, sjunde: 7, åttonde: 8, nionde: 9, tionde: 10, elfte: 11, tolfte: 12, trettonde: 13, fjortonde: 14, femtonde: 15, sextonde: 16, sjuttonde: 17, artonde: 18, nittonde: 19, tjugonde: 20, trettionde: 30,
	første: 1, fjerde: 4, sjette: 6, syvende: 7, sjuende: 7, åttende: 8, niende: 9, tiende: 10, ellevte: 11, tolvte: 12, trettende: 13, fjortende: 14, femtende: 15, sekstende: 16, syttende: 17, attende: 18, nittende: 19, tjuende: 20, trettiende: 30,
	erste: 1, ersten: 1, erster: 1, zweite: 2, zweiten: 2, dritte: 3, dritten: 3, vierte: 4, vierten: 4, fünfte: 5, fünften: 5, sechste: 6, sechsten: 6, siebte: 7, siebten: 7, achte: 8, achten: 8, neunte: 9, neunten: 9, zehnte: 10, zehnten: 10, zwölfte: 12, zwölften: 12, zwanzigste: 20, zwanzigsten: 20, dreißigste: 30, dreißigsten: 30,
	premier: 1, première: 1,
};

/** "ninth" → 9, "twenty-first" → 21, "21st" → 21, "nionde" → 9, "neunten" → 9, "premier" → 1, "vingt et un" → 21. */
export function dayNumber(w: string): number | undefined {
	const t = normalizeTranscript(w).replace(/(\d)(st|nd|rd|th|e|er|:e|:a|\.)$/, "$1");
	if (t in ORDINALS) return ORDINALS[t];
	const m = t.match(/^(twenty|thirty)[ -](first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)$/);
	if (m) return SMALL[m[1]] + ORDINALS[m[2]];
	const sv = t.match(/^(tjugo|tretti|trettio|tjue)(första|andra|tredje|fjärde|femte|sjätte|sjunde|åttonde|nionde|første|fjerde|sjette|sjuende|syvende|åttende|niende)$/);
	if (sv) return SMALL[sv[1]] + ORDINALS[sv[2]];
	const de = t.match(/^(ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun)und(zwanzig|dreißig)ste[nr]?$/);
	if (de) return (de[1] === "ein" ? 1 : SMALL[de[1]]) + SMALL[de[2]];
	const st = t.replace(/(ste|sten|te|ten|nde|de)$/, "");
	if (st !== t && st in SMALL) return SMALL[st];
	return wordsToNumber(t);
}

export function parseDateText(text: string, ctx: InterpretContext): { at: Date; confidence: number } | undefined {
	const t = normalizeTranscript(text);
	if (t in DAY_WORDS) return { at: new Date(ctx.utteredAt.getTime() + DAY_WORDS[t] * 86400000), confidence: 0.95 };
	let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (m) return { at: fromParts({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), h: 12, min: 0 }, ctx), confidence: 0.95 };
	m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
	if (m) return { at: fromParts({ y: Number(m[3]), m: Number(m[2]), d: Number(m[1]), h: 12, min: 0 }, ctx), confidence: 0.85 };
	const now = partsIn(ctx.utteredAt, ctx);
	// "the ninth of september" · "den nionde september" · "niende september" · "am neunten september" · "le neuf septembre" · "le 9 septembre 2026"
	m = t.match(/^(?:the |den |le |am |der |die |il )?(\d{1,2}(?:st|nd|rd|th|e|er|:e|:a|\.)?|[a-zäöüåæøéèêç-]+(?: et une?)?)(?: of| de| des)? ([a-zäöüåæøéèêç.]+)(?: (\d{4}))?$/);
	if (m) {
		const d = dayNumber(m[1]);
		const mi = monthIndex(m[2]);
		if (d !== undefined && mi >= 0 && d >= 1 && d <= 31) return { at: fromParts({ y: m[3] ? Number(m[3]) : now.y, m: mi + 1, d, h: 12, min: 0 }, ctx), confidence: 0.8 };
	}
	// "september ninth" · "september 9"
	m = t.match(/^([a-zäöüåæøéèêç.]+) (\d{1,2}(?:st|nd|rd|th)?|[a-z-]+)(?: (\d{4}))?$/);
	if (m) {
		const mi = monthIndex(m[1]);
		const d = dayNumber(m[2]);
		if (d !== undefined && mi >= 0 && d >= 1 && d <= 31) return { at: fromParts({ y: m[3] ? Number(m[3]) : now.y, m: mi + 1, d, h: 12, min: 0 }, ctx), confidence: 0.8 };
	}
	return undefined;
}

// ---------------------------------------------------------------- per-type

const YES = /^(yes|yep|yeah|yup|affirmative|correct|done|checked|true|confirmed|complete(d)?|ok(ay)?|positive|check|all good|good|ja|jo|jepp|javisst|jada|klart|ferdig|gjort|utfört|richtig|erledigt|fertig|stimmt|oui|ouais|fait|vrai|terminé|d'accord)$/;
const NO = /^(no|nope|negative|not done|unchecked|false|incomplete|not yet|nei|nej|inte|ikke|nein|nicht|non|pas fait|pas encore)$/;
const NA_WORDS = ["n/a", "na", "n a", "en a", "not applicable", "non applicable", "ikke aktuelt", "ikke relevant", "ej tillämpligt", "inte tillämpligt", "ej aktuellt", "inte aktuellt", "nicht zutreffend", "nicht anwendbar", "entfällt", "sans objet", "pas applicable"];
const UNIT_STRIP = /\b(degrees|degrés|grader|grad|celsius|percent|per cent|prosent|procent|prozent|pour cent|meters|metres|meter|mètres|bar|knots|knop|knoten|nœuds|noeuds|kn|tonnes|tons|ton|litres|liters|liter|rpm|kg|mm|cm|m)\b/g;

/**
 * Remove the bound phrase / item name from the front of the transcript so "pilot on board five
 * minutes ago" leaves "five minutes ago". A trailing part of the phrase counts too ("engine
 * started" for the item "Main engine started"), so crews can drop leading words.
 */
export function stripPhrase(t: string, phrases: string[] | undefined): string {
	let out = t;
	for (const p of phrases ?? []) {
		const words = normalizeTranscript(p).split(" ").filter(Boolean);
		for (let k = words.length; k >= 1; k--) {
			const tail = words.slice(words.length - k).join(" ");
			if (k === 1 && tail.length < 5) break;
			if (out === tail || out.startsWith(`${tail} `) || out.startsWith(`${tail},`)) {
				out = out.slice(tail.length).trim().replace(/^[,:-]\s*/, "");
				break;
			}
		}
	}
	return out;
}

function fuzzyScore(a: string, b: string): number {
	if (a === b) return 1;
	if (!a || !b) return 0;
	if (b.includes(a) || a.includes(b)) return 0.85;
	const wa = new Set(a.split(" "));
	const wb = new Set(b.split(" "));
	let inter = 0;
	for (const w of wa) if (wb.has(w)) inter++;
	const j = inter / (wa.size + wb.size - inter);
	if (j > 0) return 0.5 + j * 0.4;
	const bg = (s: string) => {
		const out = new Set<string>();
		for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
		return out;
	};
	const A = bg(a);
	const B = bg(b);
	let c = 0;
	for (const x of A) if (B.has(x)) c++;
	return A.size && B.size ? ((2 * c) / (A.size + B.size)) * 0.8 : 0;
}

export function interpret(type: string, transcript: string, ctx: InterpretContext, phrases?: string[]): Interpretation {
	const lang: Lang = normLang(ctx.language);
	const msg = (key: string, params: Record<string, string | number> = {}) => tr(lang, key, params);
	const raw = transcript.trim();
	const normalized = normalizeTranscript(raw);
	if (!normalized) return { ok: false, reason: "empty", message: msg("m_empty"), confidence: 0 };
	const stripped = stripPhrase(normalized, phrases);
	/** The user said only the bound phrase ("engine started"): the event itself, with no value attached. */
	const phraseOnly = !stripped;
	const t = stripped || normalized;
	const nowText = () => `${msg("now")}, ${formatClock(ctx.utteredAt, ctx)}`;
	switch (type) {
		case "DateAndTime": {
			if (phraseOnly) return { ok: true, value: ctx.utteredAt.toISOString(), valueText: nowText(), confidence: 0.85, kind: "now" };
			const rel = parseRelative(t, ctx);
			if (rel) {
				if (rel.confidence < 0.5) return { ok: false, reason: "implausible", message: msg("m_implausible", { value: rel.text, hours: ctx.maxPastHours }), confidence: rel.confidence };
				return { ok: true, value: rel.at.toISOString(), valueText: rel.text === "now" ? nowText() : formatClock(rel.at, ctx), confidence: rel.confidence, kind: "relative" };
			}
			const clock = parseClock(t);
			if (clock) {
				const at = resolveClock(clock, ctx);
				if (ctx.utteredAt.getTime() - at.getTime() > ctx.maxPastHours * 3600000) return { ok: false, reason: "implausible", message: msg("m_implausible", { value: formatClock(at, ctx), hours: ctx.maxPastHours }), confidence: 0.3 };
				return { ok: true, value: at.toISOString(), valueText: formatClock(at, ctx), confidence: clock.confidence, kind: "clock" };
			}
			if (YES.test(t)) return { ok: true, value: ctx.utteredAt.toISOString(), valueText: nowText(), confidence: 0.85, kind: "now" };
			return { ok: false, reason: "no_match", message: msg("m_when"), confidence: 0.1 };
		}
		case "Time": {
			const rel = parseRelative(t, ctx);
			if (rel) {
				const p = partsIn(rel.at, ctx);
				return { ok: true, value: `${pad(p.h)}:${pad(p.min)}`, valueText: formatClock(rel.at, ctx), confidence: rel.confidence, kind: "relative" };
			}
			const clock = parseClock(t);
			if (clock) return { ok: true, value: `${pad(clock.h)}:${pad(clock.min)}`, valueText: `${pad(clock.h)}:${pad(clock.min)}${ctx.tzMode === "utc" ? ` ${msg("utc")}` : ""}`, confidence: clock.confidence, kind: "clock" };
			return { ok: false, reason: "no_match", message: msg("m_time"), confidence: 0.1 };
		}
		case "Date": {
			const d = parseDateText(t, ctx);
			if (d) return { ok: true, value: formatDate(d.at, ctx), valueText: formatDate(d.at, ctx), confidence: d.confidence, kind: "date" };
			return { ok: false, reason: "no_match", message: msg("m_date"), confidence: 0.1 };
		}
		case "Number": {
			const cleaned = t.replace(UNIT_STRIP, "").replace(/\s+/g, " ").trim();
			const n = wordsToNumber(cleaned);
			if (n !== undefined) return { ok: true, value: String(n), valueText: String(n), confidence: 0.9, kind: "number" };
			return { ok: false, reason: "no_match", message: msg("m_number"), confidence: 0.1 };
		}
		case "Checkbox": {
			// Flow stores a plain checkbox as "OK" (checked) or nothing (TaskValueValidation.cs); "true"/"false" are rejected.
			// A checkbox authored with options ("Utført::completed") stores the option key instead: one option is still a
			// yes/no question, several make it a multi-select answered like a Dropdown.
			// "no" therefore carries no value: the engine leaves the item open (CHECKBOX_NOT_DONE) instead of writing.
			const opts = ctx.options ?? [];
			if (opts.length > 1) return interpret("Dropdown", transcript, ctx, phrases);
			const checked = checkboxCheckedValue(opts);
			const yesText = checked.title ?? msg("yes");
			if (phraseOnly) return { ok: true, value: checked.value, valueText: yesText, confidence: 0.8, kind: "bool" };
			if (YES.test(t)) return { ok: true, value: checked.value, valueText: yesText, confidence: 0.95, kind: "bool" };
			if (checked.title && fuzzyScore(t, normalizeTranscript(checked.title)) >= 0.7) return { ok: true, value: checked.value, valueText: yesText, confidence: 0.9, kind: "bool" };
			if (NO.test(t)) return { ok: true, value: CHECKBOX_NOT_DONE, valueText: msg("no"), confidence: 0.95, kind: "bool" };
			if (NA_WORDS.includes(t)) return { ok: false, reason: "no_match", message: msg("m_yesno_na"), confidence: 0.2 };
			return { ok: false, reason: "no_match", message: msg("m_yesno"), confidence: 0.1 };
		}
		case "QuickSelect":
		case "Dropdown":
		case "RadioButtons": {
			const options = ctx.options ?? [];
			if (!options.length && type === "RadioButtons") {
				// a RadioButtons control without its own option list is Flow's yes/no: it accepts exactly "Yes" / "No"
				if (YES.test(t)) return { ok: true, value: "Yes", valueText: msg("yes"), confidence: 0.95, kind: "bool" };
				if (NO.test(t)) return { ok: true, value: "No", valueText: msg("no"), confidence: 0.95, kind: "bool" };
				return { ok: false, reason: "no_match", message: msg("m_yesno"), confidence: 0.1 };
			}
			if (!options.length) return { ok: true, value: raw, valueText: raw, confidence: 0.5, kind: "free" };
			const scored = options
				.map((o) => {
					const title = normalizeTranscript(o.title);
					const value = normalizeTranscript(o.value);
					let score = Math.max(fuzzyScore(t, title), fuzzyScore(t, value));
					if (NA_WORDS.includes(t) && (NA_WORDS.includes(title) || NA_WORDS.includes(value) || /^(n\/?a|not applicable)$/.test(title))) score = 1;
					if ((YES.test(t) && /^(yes|ok|done|checked|ja|oui|jo)$/.test(title)) || (NO.test(t) && /^(no|nei|nej|nein|non|not done)$/.test(title))) score = 0.95;
					const idx = options.indexOf(o) + 1;
					const ordinal = t.replace(/^(option|number|choice|alternative|alternativ|valg|nummer|numéro|numero|choix)\s+/, "");
					if (ordinal === String(idx) || wordsToNumber(ordinal) === idx || ORDINALS[ordinal] === idx) score = Math.max(score, 0.8);
					return { o, score };
				})
				.sort((a, b) => b.score - a.score);
			const best = scored[0];
			const second = scored[1];
			if (best.score >= 0.6 && (!second || second.score < best.score - 0.1 || second.o.value === best.o.value)) return { ok: true, value: best.o.value, valueText: best.o.title, confidence: Math.min(0.98, best.score), kind: "option" };
			if (best.score >= 0.6) return { ok: false, reason: "ambiguous", message: msg("m_ambiguous", { a: best.o.title, b: second.o.title }), confidence: best.score };
			return { ok: false, reason: "no_match", message: msg("m_options", { options: options.map((o) => o.title).join(", ") }), confidence: best.score };
		}
		case "Text":
			return { ok: true, value: raw.replace(/\s+/g, " ").trim(), valueText: raw.replace(/\s+/g, " ").trim(), confidence: 0.8, kind: "text" };
		case "LongText":
			return { ok: true, value: raw, valueText: raw, confidence: 0.8, kind: "text" };
		default:
			return { ok: false, reason: "no_match", message: msg("m_screen", { type }), confidence: 0 };
	}
}

/** Read-back text: absolute, never relative (spec section 9), in the run's language. */
export function readbackText(itemName: string, _type: string, i: Extract<Interpretation, { ok: true }>, lang: Lang | string = "en"): string {
	return tr(lang, "readback", { name: itemName, value: i.valueText });
}
