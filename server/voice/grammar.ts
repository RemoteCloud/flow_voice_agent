/**
 * The allowed vocabulary of a listen window, for a grammar-restricted recogniser on the endpoint (Vosk on
 * Android): the phone only ever returns words from this list, so room talk comes back as nothing instead
 * of as a wrong answer. Pure. English is always included (the hub understands it on every checklist); the
 * run language adds its own words. Free-text items get no grammar — they need open dictation.
 */
import { normLang } from "./i18n.js";

const CONTROL: Record<string, string[]> = {
	en: ["confirm", "confirmed", "yes", "no", "ok", "okay", "correct", "correction", "say again", "repeat", "skip", "next", "next item", "back", "pause", "resume", "help", "not applicable", "cancel", "done", "checked", "now", "just now", "list", "where am i"],
	sv: ["bekräfta", "ja", "nej", "okej", "stämmer", "rättelse", "säg igen", "upprepa", "hoppa över", "nästa", "tillbaka", "paus", "fortsätt", "hjälp", "ej tillämpligt", "inte aktuellt", "avbryt", "utfört", "klart", "gjort", "nu"],
	no: ["bekreft", "ja", "nei", "greit", "stemmer", "rettelse", "gjenta", "si igjen", "hopp over", "neste", "tilbake", "pause", "fortsett", "hjelp", "ikke aktuelt", "avbryt", "utført", "ferdig", "gjort", "nå"],
	de: ["bestätigen", "bestätigt", "ja", "nein", "okay", "stimmt", "korrektur", "wiederholen", "nochmal", "überspringen", "weiter", "zurück", "pause", "hilfe", "nicht zutreffend", "abbrechen", "erledigt", "fertig", "jetzt"],
	fr: ["confirmer", "confirmé", "oui", "non", "d'accord", "correction", "répéter", "encore", "passer", "suivant", "retour", "pause", "aide", "sans objet", "annuler", "fait", "terminé", "maintenant"],
};

const NUMBERS: Record<string, string[]> = {
	en: ["zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "point", "half", "quarter", "minus"],
	sv: ["noll", "ett", "en", "två", "tre", "fyra", "fem", "sex", "sju", "åtta", "nio", "tio", "elva", "tolv", "tretton", "fjorton", "femton", "sexton", "sjutton", "arton", "nitton", "tjugo", "trettio", "fyrtio", "femtio", "sextio", "sjuttio", "åttio", "nittio", "hundra", "tusen", "komma", "halv", "kvart", "minus"],
	no: ["null", "en", "ett", "to", "tre", "fire", "fem", "seks", "sju", "syv", "åtte", "ni", "ti", "elleve", "tolv", "tretten", "fjorten", "femten", "seksten", "sytten", "atten", "nitten", "tjue", "tretti", "førti", "femti", "seksti", "sytti", "åtti", "nitti", "hundre", "tusen", "komma", "halv", "kvart", "minus"],
	de: ["null", "eins", "ein", "eine", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig", "hundert", "tausend", "komma", "und", "halb", "viertel", "minus"],
	fr: ["zéro", "un", "une", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "vingt", "trente", "quarante", "cinquante", "soixante", "cent", "mille", "virgule", "et", "demi", "quart", "moins"],
};

const TIME: Record<string, string[]> = {
	en: ["minute ago", "minutes ago", "hour ago", "hours ago", "half an hour ago", "a quarter of an hour ago", "an hour ago", "at", "o'clock", "hundred hours", "a m", "p m", "this morning", "yesterday"],
	sv: ["minut sedan", "minuter sedan", "för minuter sedan", "timme sedan", "timmar sedan", "en halvtimme sedan", "klockan", "i morse", "igår"],
	no: ["minutt siden", "minutter siden", "for minutter siden", "time siden", "timer siden", "en halvtime siden", "klokken", "klokka", "i dag tidlig", "i går"],
	de: ["vor minuten", "vor einer minute", "vor einer stunde", "vor stunden", "vor einer halben stunde", "um", "uhr", "heute morgen", "gestern"],
	fr: ["il y a minutes", "il y a une minute", "il y a une heure", "il y a heures", "il y a une demi-heure", "à", "heures", "ce matin", "hier"],
};

export interface GrammarItem {
	type: string;
	name: string;
	options?: { title: string; value: string }[];
}

/** Phrases the recogniser may return for this window, or undefined when the item needs free dictation. */
export function grammarFor(language: string | undefined, item: GrammarItem, extraPhrases: string[] = [], confirming = false): string[] | undefined {
	if (item.type === "Text" || item.type === "LongText") return undefined;
	const lang = normLang(language);
	const langs = lang === "en" ? ["en"] : ["en", lang];
	const out = new Set<string>();
	for (const l of langs) for (const w of CONTROL[l] ?? []) out.add(w);
	if (!confirming) {
		const numeric = item.type === "Number" || item.type === "Time" || item.type === "DateAndTime" || item.type === "Date";
		if (numeric) for (const l of langs) for (const w of NUMBERS[l] ?? []) out.add(w);
		if (item.type === "Time" || item.type === "DateAndTime" || item.type === "Date") for (const l of langs) for (const w of TIME[l] ?? []) out.add(w);
		for (const o of item.options ?? []) out.add(o.title.toLowerCase());
	}
	// the item name itself (an unprompted "pilot on board" or a read-back repeat) and the bound phrases
	for (const p of [item.name, ...extraPhrases]) {
		const t = p.toLowerCase().replace(/[?.!,:;()"]/g, " ").replace(/\s+/g, " ").trim();
		if (t) out.add(t);
	}
	return [...out];
}
