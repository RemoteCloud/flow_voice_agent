/**
 * Which voice reads the checklist, per language.
 *
 * A voice id is "hub:<voice>" (the hub's voice server, GET /api/tts?voice=) or the name of a voice this device has
 * (a browser `speechSynthesis` voice, or an Android TTS voice through the bridge). Admin sets one default per language
 * for every device (`settings.voices`, boot `speech.voices`); the person on a device may pick another one, kept in this
 * device's `localStorage` (`fv.voices`). "auto" = this device's own choice (the hub's default voice when the hub has
 * one, else the best installed voice for the language), even when Admin set a default.
 */
import type { DeviceValue } from "../../server/protocol.js";
import type { StationView } from "../../server/api.js";

export const VOICE_LANGS = ["en", "sv", "no", "fr", "de"] as const;
export const VOICE_LANG_NAMES: Record<string, string> = { en: "English", sv: "Swedish", no: "Norwegian", fr: "French", de: "German" };
export const AUTO_VOICE = "auto";
const KEY = "fv.voices";

/** "nb-NO" / "nn" / "no" → "no"; otherwise the two-letter base. */
export function voiceLang(tag: string): string {
	const base = tag.toLowerCase().split(/[-_]/)[0] ?? "";
	return base === "nb" || base === "nn" ? "no" : base;
}

/** BCP-47 tag for a two-letter language, as the speech engines want it. */
export function voiceTag(language: string): string {
	return language.length === 2 ? ({ en: "en-GB", no: "nb-NO", nb: "nb-NO", sv: "sv-SE", de: "de-DE", fr: "fr-FR", da: "da-DK" } as Record<string, string>)[language] ?? language : language;
}

export function deviceVoices(): Record<string, string> {
	try {
		const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
		return v && typeof v === "object" ? (v as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** "" = follow Admin's default again. */
export function setDeviceVoice(lang: string, id: string): void {
	const all = deviceVoices();
	if (id) all[lang] = id;
	else delete all[lang];
	try {
		localStorage.setItem(KEY, JSON.stringify(all));
	} catch {
		/* private window: the choice lasts until the page is closed */
	}
	window.dispatchEvent(new Event("fv-voices"));
}

/** The voice this device reads `language` with: its own pick, else Admin's default, else undefined (= automatic). */
export function chosenVoice(language: string, adminDefaults: Record<string, string> | undefined): string | undefined {
	const lang = voiceLang(language);
	const id = deviceVoices()[lang] ?? adminDefaults?.[lang];
	return id && id !== AUTO_VOICE ? id : undefined;
}

export interface VoiceOption {
	id: string;
	label: string;
	group: "hub" | "device" | "seen";
}

const aliases = (lang: string) => (lang === "no" ? ["nb", "no", "nn"] : [lang]);

/** The browser's installed voices for a language (Chrome loads the list late: wait for it once). */
export async function browserVoices(lang: string): Promise<SpeechSynthesisVoice[]> {
	if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
	if (!window.speechSynthesis.getVoices().length) {
		await new Promise<void>((ready) => {
			const t = window.setTimeout(ready, 1200);
			window.speechSynthesis.addEventListener("voiceschanged", () => (window.clearTimeout(t), ready()), { once: true });
		});
	}
	const want = aliases(lang);
	return window.speechSynthesis.getVoices().filter((v) => want.includes(v.lang.toLowerCase().split(/[-_]/)[0]!));
}

/** Every voice this device can read `lang` with: the hub's, then its own (Android engine or browser). */
export async function voiceOptions(lang: string, hubVoices: Record<string, string[]> | undefined): Promise<VoiceOption[]> {
	const out: VoiceOption[] = (hubVoices?.[lang] ?? []).map((v) => ({ id: `hub:${v}`, label: `${v} (hub)`, group: "hub" }));
	const android = window.FlowVoiceAndroid;
	if (android?.voices) {
		try {
			const list = JSON.parse(android.voices(voiceTag(lang))) as { name: string; label?: string }[];
			for (const v of list) out.push({ id: v.name, label: v.label || v.name, group: "device" });
		} catch {
			/* older app or engine not ready */
		}
	} else if (!android) {
		for (const v of await browserVoices(lang)) out.push({ id: v.name, label: `${v.name}${v.localService ? "" : " (online)"}`, group: "device" });
	}
	return out;
}

/** Voice names the stations' devices reported (device info), per language: what Admin can offer besides the hub's. */
export function seenVoices(stations: StationView[]): Record<string, string[]> {
	const out: Record<string, Set<string>> = {};
	const add = (lang: string, name: string) => {
		const l = voiceLang(lang);
		if (!(VOICE_LANGS as readonly string[]).includes(l) || !name) return;
		(out[l] ??= new Set()).add(name);
	};
	const walk = (v: DeviceValue | undefined, depth: number) => {
		if (!v || typeof v !== "object" || depth > 5) return;
		if (Array.isArray(v)) return;
		for (const [k, x] of Object.entries(v)) {
			if (k === "voices" && x && typeof x === "object" && !Array.isArray(x)) {
				// Android: { nb: ["nb-no-x-cfs-local (high, offline)", …] }; browser: { ours: ["Nora (nb-NO)", …] }
				for (const [lang, list] of Object.entries(x)) {
					if (!Array.isArray(list)) continue;
					for (const s of list) {
						if (typeof s !== "string") continue;
						const m = /^(.*?) \(([^)]*)\)$/.exec(s);
						const name = (m?.[1] ?? s).trim();
						if (lang === "ours") add(m?.[2]?.split(",")[0]?.trim() ?? "", name);
						else add(lang, name);
					}
				}
			} else walk(x, depth + 1);
		}
	};
	for (const s of stations) {
		walk(s.endpoint?.device as DeviceValue | undefined, 0);
		walk(s.device?.info as DeviceValue | undefined, 0);
	}
	return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

const SAMPLE: Record<string, string> = {
	en: "Check lube oil pressure. Confirmed.",
	sv: "Kontrollera smörjoljetrycket. Bekräftat.",
	no: "Kontroller smøreoljetrykket. Bekreftet.",
	fr: "Vérifiez la pression d'huile. Confirmé.",
	de: "Öldruck prüfen. Bestätigt.",
};

let previewAudio: HTMLAudioElement | undefined;

/** Read a short sample with a voice, here, so the person hears it before picking it. */
export async function previewVoice(lang: string, id: string | undefined): Promise<void> {
	const text = SAMPLE[lang] ?? SAMPLE.en!;
	previewAudio?.pause();
	if (!id || id === AUTO_VOICE) id = undefined;
	if (id?.startsWith("hub:") || (!id && !window.FlowVoiceAndroid && !("speechSynthesis" in window))) {
		const res = await fetch(`/api/tts?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text)}${id ? `&voice=${encodeURIComponent(id.slice(4))}` : ""}`, { credentials: "same-origin" });
		if (!res.ok) throw new Error("The hub could not read it with that voice.");
		const url = URL.createObjectURL(await res.blob());
		previewAudio = new Audio(url);
		previewAudio.onended = () => URL.revokeObjectURL(url);
		await previewAudio.play();
		return;
	}
	const android = window.FlowVoiceAndroid;
	if (android) {
		if (id && android.speakWith) android.speakWith(text, voiceTag(lang), "preview", id);
		else android.speak(text, voiceTag(lang), "preview");
		return;
	}
	const synth = window.speechSynthesis;
	const voices = await browserVoices(lang);
	const u = new SpeechSynthesisUtterance(text);
	u.lang = voiceTag(lang);
	const v = id ? voices.find((x) => x.name === id) : voices.find((x) => x.localService) ?? voices[0];
	if (v) u.voice = v;
	synth.cancel();
	synth.speak(u);
}
