/**
 * Server-side voice: the hub asks a Piper HTTP server (`python -m piper.http_server`, `TTS_ENDPOINT`) for a WAV and hands
 * it to the client, so every computer reads a checklist with the same voice in the right language, whatever voices the
 * browser has. Generated speech is kept in RAM only (a small cache: checklist items repeat); nothing is written to disk.
 */
import type { Logger } from "../core/log.js";

/** Piper voice per language; override with `TTS_VOICES="no=no_NO-talesyntese-medium,en=…"`. */
export const DEFAULT_TTS_VOICES: Record<string, string> = {
	en: "en_GB-alba-medium",
	no: "no_NO-talesyntese-medium",
	sv: "sv_SE-nst-medium",
	de: "de_DE-thorsten-medium",
	fr: "fr_FR-siwis-medium",
};

export function parseVoices(raw: string | undefined): Record<string, string> {
	const out = { ...DEFAULT_TTS_VOICES };
	for (const pair of (raw ?? "").split(",")) {
		const [k, v] = pair.split("=").map((x) => x.trim());
		if (k && v) out[k.toLowerCase()] = v;
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
	constructor(private readonly deps: { url: string; voices: Record<string, string>; log: Logger; timeoutMs?: number; fetch?: typeof fetch }) {}

	supports(lang: string): boolean {
		return !!this.deps.voices[ttsLang(lang)];
	}

	async speak(text: string, lang: string): Promise<Buffer> {
		const voice = this.deps.voices[ttsLang(lang)];
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
