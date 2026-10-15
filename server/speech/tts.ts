/**
 * Server-side voice: the hub asks a Piper HTTP server (`python -m piper.http_server`, `TTS_ENDPOINT`) for a WAV and hands
 * it to the client, so every computer reads a checklist with the same voice in the right language, whatever voices the
 * browser has. Generated speech is kept in RAM only (a small cache: checklist items repeat); nothing is written to disk.
 */
import type { Logger } from "../core/log.js";

/** Piper voice per language; override with `TTS_VOICES="no=no_NO-talesyntese-medium,en=…"`. Several per language with "|"
 * (`no=no_NO-talesyntese-medium|no_NO-other-medium`): the first is the default, the others can be picked per device or in Admin. */
export const DEFAULT_TTS_VOICES: Record<string, string> = {
	en: "en_GB-alba-medium",
	no: "no_NO-talesyntese-medium",
	sv: "sv_SE-nst-medium",
	de: "de_DE-thorsten-medium",
	fr: "fr_FR-siwis-medium",
};

export function parseVoices(raw: string | undefined): Record<string, string[]> {
	const out: Record<string, string[]> = Object.fromEntries(Object.entries(DEFAULT_TTS_VOICES).map(([k, v]) => [k, [v]]));
	for (const pair of (raw ?? "").split(",")) {
		const [k, v] = pair.split("=").map((x) => x.trim());
		const list = (v ?? "").split("|").map((x) => x.trim()).filter(Boolean);
		if (k && list.length) out[ttsLang(k)] = [...new Set(list)];
	}
	return out;
}

/** "nb-NO" / "nb" / "nn" → "no"; otherwise the two-letter base. */
export const ttsLang = (tag: string): string => {
	const base = tag.toLowerCase().split(/[-_]/)[0] ?? "";
	return base === "nb" || base === "nn" ? "no" : base;
};

const MAX_CACHE_BYTES = 24 * 1024 * 1024;
export const MAX_TTS_CHARS = 600;

export class HttpTts {
	private readonly cache = new Map<string, Buffer>();
	private bytes = 0;
	constructor(private readonly deps: { url: string; voices: Record<string, string[]>; log: Logger; timeoutMs?: number; fetch?: typeof fetch }) {}

	/** Language → voices the voice server has (first = the default for that language). */
	voices(): Record<string, string[]> {
		return Object.fromEntries(Object.entries(this.deps.voices).map(([k, v]) => [k, [...v]]));
	}

	supports(lang: string): boolean {
		return !!this.deps.voices[ttsLang(lang)]?.length;
	}

	/** The voice to use: `wanted` when the server has it for this language, else the language's default. */
	voiceFor(lang: string, wanted?: string): string | undefined {
		const list = this.deps.voices[ttsLang(lang)] ?? [];
		return wanted && list.includes(wanted) ? wanted : list[0];
	}

	async speak(text: string, lang: string, wanted?: string): Promise<Buffer> {
		const voice = this.voiceFor(lang, wanted);
		if (!voice) throw new Error(`no server voice for ${lang}`);
		const key = `${voice}\n${text}`;
		const hit = this.cache.get(key);
		if (hit) {
			this.cache.delete(key); // most recently used goes last
			this.cache.set(key, hit);
			return hit;
		}
		const res = await (this.deps.fetch ?? fetch)(this.deps.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice }), signal: AbortSignal.timeout(this.deps.timeoutMs ?? 10_000) });
		if (!res.ok) throw new Error(`voice server HTTP ${res.status}`);
		const wav = Buffer.from(await res.arrayBuffer());
		if (wav.length < 44 || wav.subarray(0, 4).toString("latin1") !== "RIFF") throw new Error("voice server did not answer with a WAV");
		this.cache.set(key, wav);
		this.bytes += wav.length;
		for (const [k, v] of this.cache) {
			if (this.bytes <= MAX_CACHE_BYTES) break;
			this.cache.delete(k);
			this.bytes -= v.length;
		}
		return wav;
	}
}
