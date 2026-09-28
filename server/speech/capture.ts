/**
 * Voice recording for training data (opt-in per station, `Station.recordVoice`).
 *
 * While a station records, its endpoint streams the microphone to the hub inside every prompt window (also when the
 * device transcribes itself). When the answer arrives the hub keeps that window as a clip: a 16 kHz mono WAV plus a
 * JSON sidecar with the flow, the item that was asked, what the recogniser heard and what the hub made of it.
 *
 * Clips are queued in `<data>/captures/` (survives restarts and days offline at sea) and, when `CAPTURE_S3_BUCKET`
 * is set, uploaded to any S3-compatible store (AWS S3, MinIO, Cloudflare R2, …) and removed locally. Without a bucket
 * they stay in the folder (oldest dropped above `CAPTURE_MAX_MB`) for copying off by hand.
 *
 * Object keys: `<prefix>/<source>/<template>/<yyyy-mm-dd>/<clipId>.wav|.json`.
 * The speaker is a pseudonym (HMAC of the user id with the hub secret), never a name or e-mail.
 */
import { createHash, createHmac } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../core/log.js";
import { pcmToWav } from "./stt.js";

export interface CaptureS3Env {
	/** Base URL of the S3 API, e.g. https://s3.eu-north-1.amazonaws.com or http://minio:9000. */
	endpoint: string;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** `endpoint/bucket/key` (MinIO, most self-hosted stores) instead of `bucket.endpoint/key`. */
	pathStyle: boolean;
}

export interface CaptureEnv {
	/** Local queue size above which the oldest clips are dropped (MB). */
	maxMb: number;
	s3?: CaptureS3Env;
}

/** Context of one clip, taken right before the hub acts on the answer. */
export interface CaptureContext {
	runId: string;
	instanceId: string;
	templateId?: string;
	templateName: string;
	language: string;
	stationId: string;
	stationName?: string;
	location?: string;
	/** What the hub was waiting for: an item answer, the read-back confirmation, a hold, the menu … */
	exchange: string;
	/** Last thing the hub said before the answer. */
	prompt?: string;
	item?: CaptureItem;
	/** Pending read-back when the answer is a confirm / no. */
	readback?: { taskId: string; valueText: string };
	/** Items as they stood before, to see what this answer changed. */
	before: { taskId: string; state: string; value?: string }[];
	speakerSub?: string;
}

export interface CaptureItem {
	taskId: string;
	dataId?: string;
	name: string;
	index: number;
	section?: string;
	type: string;
	options?: { title: string; value: string }[];
	answerWords?: string[];
	triggerWords?: string[];
}

export interface CaptureOutcome {
	/** Items this answer set, skipped or reopened, with their state afterwards. */
	changed: { taskId: string; dataId?: string; name: string; state: string; value?: string; valueText?: string }[];
	/** The hub asked for confirmation of this value (the next clip holds the crew's yes / no). */
	readback?: { taskId: string; value: string; valueText: string };
	exchange: string;
	runState: string;
}

export interface CaptureRecognition {
	text: string;
	confidence?: number;
	alternatives?: string[];
	/** Who turned the audio into text: the device itself, or the hub's recogniser. */
	by: "endpoint" | "hub";
	language?: string;
}

export interface CaptureStatus {
	target: "s3" | "local";
	bucket?: string;
	queued: number;
	queuedBytes: number;
	uploaded: number;
	lastUploadAt?: string;
	lastError?: string;
}

// ------------------------------------------------------------ SigV4 (pure)

const sha256Hex = (data: string | Buffer | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as S3 wants it; `/` kept in object keys. */
export function s3Encode(v: string, keepSlash = false): string {
	return encodeURIComponent(v)
		.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
		.replace(keepSlash ? /%2F/g : /$^/, "/");
}

/**
 * AWS Signature Version 4 for one S3 request. `headers` must hold every header to sign except `host`,
 * `x-amz-date` and `x-amz-content-sha256`, which are added. Returns the full header set to send.
 */
export function signS3(req: { method: string; url: string; region: string; accessKeyId: string; secretAccessKey: string; payloadHash: string; headers?: Record<string, string>; now: Date }): Record<string, string> {
	const u = new URL(req.url);
	const amzDate = req.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	const day = amzDate.slice(0, 8);
	const headers: Record<string, string> = { host: u.host, "x-amz-content-sha256": req.payloadHash, "x-amz-date": amzDate };
	for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v.trim();
	const names = Object.keys(headers).sort();
	const canonicalHeaders = names.map((k) => `${k}:${headers[k]}\n`).join("");
	const signedHeaders = names.join(";");
	const query = [...u.searchParams.entries()]
		.map(([k, v]) => [s3Encode(k), s3Encode(v)])
		.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
		.map(([k, v]) => `${k}=${v}`)
		.join("&");
	const canonical = [req.method, u.pathname || "/", query, canonicalHeaders, signedHeaders, req.payloadHash].join("\n");
	const scope = `${day}/${req.region}/s3/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
	let key = hmac(`AWS4${req.secretAccessKey}`, day);
	key = hmac(key, req.region);
	key = hmac(key, "s3");
	key = hmac(key, "aws4_request");
	const signature = createHmac("sha256", key).update(toSign).digest("hex");
	const out: Record<string, string> = { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
	delete out.host; // fetch sets it
	return out;
}

/** URL of an object: virtual-hosted (`bucket.host/key`) or path style (`host/bucket/key`). */
export function objectUrl(s3: Pick<CaptureS3Env, "endpoint" | "bucket" | "pathStyle">, key: string): string {
	const base = new URL(s3.endpoint);
	const k = s3Encode(key, true);
	if (s3.pathStyle) return `${base.origin}${base.pathname.replace(/\/$/, "")}/${s3Encode(s3.bucket)}/${k}`;
	return `${base.protocol}//${s3.bucket}.${base.host}${base.pathname.replace(/\/$/, "")}/${k}`;
}

/** Path segment safe for an object key and a file name. */
export function slug(v: string | undefined, fallback = "unknown"): string {
	const s = (v ?? "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return s || fallback;
}

/** The sidecar written next to every clip (schema `flow-voice.capture/1`). Pure, so it is smoke-tested. */
export function captureRecord(p: { clipId: string; recordedAt: Date; pcmBytes: number; source: { hub: string; core: string; tenant?: string }; ctx: CaptureContext; outcome: CaptureOutcome; recognition: CaptureRecognition; windowId: string; speaker?: string }) {
	const { ctx } = p;
	return {
		schema: "flow-voice.capture/1",
		clipId: p.clipId,
		recordedAt: p.recordedAt.toISOString(),
		audio: { format: "wav", encoding: "pcm_s16le", sampleRate: 16000, channels: 1, durationMs: Math.round(p.pcmBytes / 32) },
		source: { hub: p.source.hub, core: p.source.core, tenant: p.source.tenant, stationId: ctx.stationId, station: ctx.stationName, location: ctx.location },
		speaker: p.speaker,
		flow: { runId: ctx.runId, instanceId: ctx.instanceId, templateId: ctx.templateId, templateName: ctx.templateName, language: ctx.language },
		window: { id: p.windowId, exchange: ctx.exchange, prompt: ctx.prompt, readback: ctx.readback },
		item: ctx.item,
		recognition: p.recognition,
		outcome: p.outcome,
	};
}

export type CaptureRecordJson = ReturnType<typeof captureRecord>;

/** Object key without extension. */
export function captureKey(prefix: string, rec: Pick<CaptureRecordJson, "clipId" | "recordedAt" | "source" | "flow">): string {
	const parts = [prefix.replace(/^\/+|\/+$/g, ""), slug(rec.source.core), slug(rec.flow.templateId ?? rec.flow.templateName), rec.recordedAt.slice(0, 10), rec.clipId];
	return parts.filter(Boolean).join("/");
}

// ------------------------------------------------------------ recorder

export interface VoiceRecorderDeps {
	dataDir: string;
	env: CaptureEnv;
	log: Logger;
	now(): number;
	/** Hub secret: the speaker pseudonym is an HMAC with it. */
	secret: string;
	source: { hub: string; core: string; tenant?: string };
	fetch?: typeof fetch;
}

const MIN_BYTES = 16000 * 2 * 0.25; // under a quarter second: nothing worth keeping

export class VoiceRecorder {
	private readonly dir: string;
	private timer: NodeJS.Timeout | undefined;
	private running: Promise<void> | undefined;
	private uploaded = 0;
	private lastUploadAt: string | undefined;
	private lastError: string | undefined;
	private failures = 0;
	private nextTryAt = 0;

	constructor(private readonly deps: VoiceRecorderDeps) {
		this.dir = path.join(deps.dataDir, "captures");
	}

	start(): void {
		this.timer = setInterval(() => void this.flush(), 30_000);
		this.timer.unref?.();
		void this.flush();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
	}

	/** Keep one window: WAV + sidecar into the queue. Never throws (a full disk must not stop a checklist). */
	async save(pcm: Buffer, ctx: CaptureContext, outcome: CaptureOutcome, recognition: CaptureRecognition, windowId: string): Promise<string | undefined> {
		if (pcm.length < MIN_BYTES) return undefined;
		const at = new Date(this.deps.now());
		const clipId = `${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}_${slug(ctx.stationId)}_${Math.random().toString(36).slice(2, 8)}`;
		const speaker = ctx.speakerSub ? createHmac("sha256", this.deps.secret).update(`speaker:${ctx.speakerSub}`).digest("hex").slice(0, 16) : undefined;
		const rec = captureRecord({ clipId, recordedAt: at, pcmBytes: pcm.length, source: this.deps.source, ctx, outcome, recognition, windowId, speaker });
		try {
			await mkdir(this.dir, { recursive: true });
			await writeFile(path.join(this.dir, `${clipId}.wav`), pcmToWav(pcm));
			// the sidecar last, via rename: a .json in the folder always has its .wav next to it
			const tmp = path.join(this.dir, `${clipId}.json.tmp`);
			await writeFile(tmp, JSON.stringify(rec, null, 2));
			await rename(tmp, path.join(this.dir, `${clipId}.json`));
			this.deps.log.debug(`voice clip ${clipId} (${(pcm.length / 32000).toFixed(1)} s, ${ctx.item?.name ?? ctx.exchange})`);
			void this.flush();
			return clipId;
		} catch (err) {
			this.deps.log.warn(`voice clip not saved: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	async status(): Promise<CaptureStatus> {
		const clips = await this.queued();
		let bytes = 0;
		for (const c of clips) bytes += c.bytes;
		return { target: this.deps.env.s3 ? "s3" : "local", bucket: this.deps.env.s3?.bucket, queued: clips.length, queuedBytes: bytes, uploaded: this.uploaded, lastUploadAt: this.lastUploadAt, lastError: this.lastError };
	}

	/** Upload what is queued (one pass at a time), or prune the local folder when there is no bucket. `force` ignores the back-off. */
	flush(force = false): Promise<void> {
		if (force) this.nextTryAt = 0;
		if (!this.running) this.running = this.pass().finally(() => (this.running = undefined));
		return this.running;
	}

	private async queued(): Promise<{ id: string; bytes: number; mtime: number }[]> {
		let names: string[];
		try {
			names = await readdir(this.dir);
		} catch {
			return [];
		}
		const out: { id: string; bytes: number; mtime: number }[] = [];
		for (const n of names) {
			if (!n.endsWith(".json")) continue;
			const id = n.slice(0, -5);
			try {
				const [j, w] = await Promise.all([stat(path.join(this.dir, n)), stat(path.join(this.dir, `${id}.wav`))]);
				out.push({ id, bytes: j.size + w.size, mtime: j.mtimeMs });
			} catch {
				/* half a pair: the .wav went missing, leave it */
			}
		}
		return out.sort((a, b) => a.mtime - b.mtime);
	}

	private async pass(): Promise<void> {
		const s3 = this.deps.env.s3;
		const clips = await this.queued();
		if (!s3) {
			await this.prune(clips);
			return;
		}
		// back off after failures (no internet at sea): 30 s, 1 min, 2 min … up to 30 min between tries
		if (this.deps.now() < this.nextTryAt) return;
		for (const c of clips) {
			try {
				const json = await readFile(path.join(this.dir, `${c.id}.json`));
				const wav = await readFile(path.join(this.dir, `${c.id}.wav`));
				const rec = JSON.parse(json.toString()) as CaptureRecordJson;
				const key = captureKey(s3.prefix, rec);
				await this.put(s3, `${key}.wav`, wav, "audio/wav");
				await this.put(s3, `${key}.json`, json, "application/json");
				await Promise.all([unlink(path.join(this.dir, `${c.id}.wav`)), unlink(path.join(this.dir, `${c.id}.json`))]);
				this.uploaded++;
				this.lastUploadAt = new Date(this.deps.now()).toISOString();
				this.lastError = undefined;
				this.failures = 0;
			} catch (err) {
				this.failures++;
				this.nextTryAt = this.deps.now() + Math.min(30 * 60_000, 30_000 * 2 ** (this.failures - 1));
				this.lastError = err instanceof Error ? err.message : String(err);
				this.deps.log.warn(`voice clip upload failed (${clips.length} waiting): ${this.lastError}`);
				await this.prune(await this.queued());
				return;
			}
		}
	}

	private async put(s3: CaptureS3Env, key: string, body: Buffer, contentType: string): Promise<void> {
		const url = objectUrl(s3, key);
		const headers = signS3({ method: "PUT", url, region: s3.region, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, payloadHash: sha256Hex(body), headers: { "content-type": contentType }, now: new Date(this.deps.now()) });
		const res = await (this.deps.fetch ?? fetch)(url, { method: "PUT", headers, body: new Uint8Array(body), signal: AbortSignal.timeout(30_000) });
		if (!res.ok) {
			const text = (await res.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
			throw new Error(`S3 ${res.status} for ${key}${text ? `: ${text}` : ""}`);
		}
	}

	/** Keep the local queue under `maxMb`: the oldest clips go first. */
	private async prune(clips: { id: string; bytes: number }[]): Promise<void> {
		const max = this.deps.env.maxMb * 1024 * 1024;
		let total = clips.reduce((s, c) => s + c.bytes, 0);
		for (const c of clips) {
			if (total <= max) return;
			await Promise.all([unlink(path.join(this.dir, `${c.id}.json`)).catch(() => undefined), unlink(path.join(this.dir, `${c.id}.wav`)).catch(() => undefined)]);
			total -= c.bytes;
			this.deps.log.warn(`voice clip ${c.id} dropped: local queue over ${this.deps.env.maxMb} MB`);
		}
	}
}
