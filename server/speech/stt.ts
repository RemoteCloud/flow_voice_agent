/**
 * Speech-to-text adapters behind one interface (spec 4.3 / 14.5). v1 ships two:
 *   - `endpoint`: the audio endpoint transcribes itself (browser Web Speech API, Android
 *     SpeechRecognizer) and sends `transcript` frames — no audio crosses the network.
 *   - `http`: raw 16 kHz mono PCM frames collected during the listen window are wrapped as WAV
 *     and POSTed to an OpenAI-compatible `/v1/audio/transcriptions` (faster-whisper-server,
 *     whisper.cpp server, LocalAI, or the cloud adapter). `STT_ENDPOINT` selects this mode.
 * The bias vocabulary (item phrases + option titles) is passed as the `prompt`.
 */
import type { Logger } from "../core/log.js";

export interface SttResult {
	text: string;
	confidence?: number;
	language?: string;
}

export interface SttAdapter {
	readonly kind: "endpoint" | "http";
	transcribe(pcm16k: Buffer, opts: { language?: string; bias?: string[] }): Promise<SttResult>;
	healthy(): Promise<boolean>;
}

/** 16-bit little-endian mono PCM → WAV container. */
export function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

export class EndpointStt implements SttAdapter {
	readonly kind = "endpoint" as const;
	async transcribe(): Promise<SttResult> {
		throw new Error("STT runs on the endpoint in this configuration (set STT_ENDPOINT for server-side transcription)");
	}
	async healthy(): Promise<boolean> {
		return true;
	}
}

export class HttpStt implements SttAdapter {
	readonly kind = "http" as const;
	constructor(
		private readonly cfg: { url: string; model: string; apiKey?: string; timeoutMs?: number },
		private readonly log: Logger,
		private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch as typeof fetch,
	) {}

	private endpoint(): string {
		const u = this.cfg.url.replace(/\/+$/, "");
		return /\/audio\/transcriptions$/.test(u) ? u : `${u}/v1/audio/transcriptions`;
	}

	async transcribe(pcm16k: Buffer, opts: { language?: string; bias?: string[] }): Promise<SttResult> {
		const form = new FormData();
		form.append("file", new Blob([new Uint8Array(pcmToWav(pcm16k))], { type: "audio/wav" }), "utterance.wav");
		form.append("model", this.cfg.model);
		form.append("response_format", "verbose_json");
		if (opts.language) form.append("language", opts.language.slice(0, 2));
		if (opts.bias?.length) form.append("prompt", opts.bias.slice(0, 40).join(", "));
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 15000);
		try {
			const res = await this.fetchImpl(this.endpoint(), { method: "POST", body: form, headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}, signal: ctrl.signal });
			if (!res.ok) throw new Error(`STT HTTP ${res.status}`);
			const body = (await res.json()) as { text?: string; language?: string; segments?: { avg_logprob?: number; no_speech_prob?: number }[] };
			let text = (body.text ?? "").trim();
			let confidence: number | undefined;
			// Whisper invents sentences on silence / engine noise: trust its own no-speech estimate, and drop bracketed non-speech tags
			if (Array.isArray(body.segments) && body.segments.length && body.segments.every((s) => typeof s.no_speech_prob === "number" && s.no_speech_prob > 0.6)) text = "";
			text = text.replace(/[\[(][^\])]*[\])]/g, " ").replace(/\s+/g, " ").trim();
			if (Array.isArray(body.segments) && body.segments.length) {
				const lp = body.segments.reduce((a, s) => a + (typeof s.avg_logprob === "number" ? s.avg_logprob : -0.5), 0) / body.segments.length;
				confidence = Math.max(0, Math.min(1, Math.exp(lp)));
			}
			return { text, confidence, language: body.language };
		} finally {
			clearTimeout(t);
		}
	}

	async healthy(): Promise<boolean> {
		try {
			const base = this.cfg.url.replace(/\/v1\/audio\/transcriptions$/, "").replace(/\/+$/, "");
			const res = await this.fetchImpl(`${base}/health`, { method: "GET" });
			return res.ok;
		} catch (err) {
			this.log.debug(`stt health: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}
}
