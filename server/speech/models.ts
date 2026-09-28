/**
 * Speech models for the phones, served from the hub: a vessel network usually has no internet, so the
 * Android agent asks the hub first (`GET /models/vosk/<lang>.zip`). The hub keeps one copy per language
 * under `<data>/models/vosk/`; an admin can drop the zip there by hand, or the hub fetches it once from
 * the upstream mirror when it can reach it. Models are public data: no sign-in needed to download them.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../core/log.js";

/** Same table as `VoskStt.MODELS` in the Android agent. */
export const VOSK_MODELS: Record<string, string> = {
	en: "vosk-model-small-en-us-0.15",
	sv: "vosk-model-small-sv-rhasspy-0.15",
	de: "vosk-model-small-de-0.15",
	fr: "vosk-model-small-fr-0.22",
};
const UPSTREAM = "https://alphacephei.com/vosk/models/";

export interface ModelState {
	language: string;
	name: string;
	/** on the hub's disk, ready to hand to phones */
	cached: boolean;
	bytes?: number;
	fetching: boolean;
}

export class SpeechModels {
	private readonly inflight = new Map<string, Promise<string>>();
	constructor(
		private readonly dataDir: string,
		private readonly log: Logger,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	private file(lang: string): string {
		return path.join(this.dataDir, "models", "vosk", `${lang}.zip`);
	}

	async list(): Promise<ModelState[]> {
		return Promise.all(
			Object.entries(VOSK_MODELS).map(async ([language, name]) => {
				const st = await stat(this.file(language)).catch(() => undefined);
				return { language, name, cached: !!st, bytes: st?.size, fetching: this.inflight.has(language) };
			}),
		);
	}

	/** Path of the zip for `lang`, fetching it from upstream first when the hub has no copy. Concurrent callers share one download. */
	ensure(lang: string): Promise<string> {
		if (!VOSK_MODELS[lang]) return Promise.reject(new Error(`no speech model for ${lang}`));
		const running = this.inflight.get(lang);
		if (running) return running;
		const p = this.fetchOnce(lang).finally(() => this.inflight.delete(lang));
		this.inflight.set(lang, p);
		return p;
	}

	private async fetchOnce(lang: string): Promise<string> {
		const file = this.file(lang);
		if (await stat(file).catch(() => undefined)) return file;
		await mkdir(path.dirname(file), { recursive: true });
		const url = `${UPSTREAM}${VOSK_MODELS[lang]}.zip`;
		this.log.info(`speech model ${lang}: fetching ${url}`);
		const res = await this.fetchImpl(url);
		if (!res.ok || !res.body) throw new Error(`upstream HTTP ${res.status} for ${VOSK_MODELS[lang]}`);
		const tmp = `${file}.part`;
		try {
			await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmp));
			await rename(tmp, file);
		} catch (err) {
			await rm(tmp, { force: true });
			throw err;
		}
		this.log.info(`speech model ${lang}: cached (${(await stat(file)).size} bytes)`);
		return file;
	}

	async open(lang: string): Promise<{ stream: ReadableStream; bytes: number }> {
		const file = await this.ensure(lang);
		const st = await stat(file);
		return { stream: Readable.toWeb(createReadStream(file)) as unknown as ReadableStream, bytes: st.size };
	}
}
