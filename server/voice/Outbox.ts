/**
 * Durable outbox: every commit is journaled in the store first, then pushed to Maranics with
 * exponential backoff, ordered per instance, using the token of the user who answered. Survives a
 * restart (the queue is part of hub.json). Callbacks to Flow / Elsa share the same queue.
 */
import type { Logger } from "../core/log.js";
import type { FlowsClient } from "../maranics/FlowsClient.js";
import type { Credentials } from "../store/credentials.js";
import type { HubStore, OutboxEntry } from "../store/HubStore.js";

export interface OutboxDeps {
	store: HubStore;
	flows: FlowsClient;
	credentials: Credentials;
	log: Logger;
	now(): number;
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
	onChange?(entry: OutboxEntry, outcome: "sent" | "failed" | "retry"): void;
}

const MAX_ATTEMPTS = 50;
const backoffMs = (attempt: number) => Math.min(5 * 60_000, 2_000 * 2 ** Math.min(attempt, 8));

export class Outbox {
	private timer: NodeJS.Timeout | undefined;
	private draining = false;
	constructor(private readonly deps: OutboxDeps) {}

	start(intervalMs = 3000): void {
		this.stop();
		this.timer = setInterval(() => void this.drain(), intervalMs);
		this.timer.unref?.();
		void this.drain();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	pending(instanceId?: string): OutboxEntry[] {
		return this.deps.store.get().outbox.filter((e) => e.state === "queued" && (!instanceId || e.instanceId === instanceId));
	}

	async enqueue(e: Omit<OutboxEntry, "id" | "createdAt" | "attempts" | "nextAt" | "state">): Promise<OutboxEntry> {
		const now = this.deps.now();
		const entry: OutboxEntry = { ...e, id: `ob_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date(now).toISOString(), attempts: 0, nextAt: new Date(now).toISOString(), state: "queued" };
		await this.deps.store.update((d) => {
			d.outbox.push(entry);
		});
		void this.drain();
		return entry;
	}

	private inflight: Promise<{ sent: number; failed: number; retry: number }> | undefined;

	/** Push everything due, one instance at a time and in order. A concurrent call joins the pass in flight. */
	drain(): Promise<{ sent: number; failed: number; retry: number }> {
		if (this.inflight) return this.inflight;
		this.inflight = this.drainPass().finally(() => (this.inflight = undefined));
		return this.inflight;
	}

	private async drainPass(): Promise<{ sent: number; failed: number; retry: number }> {
		if (this.draining) return { sent: 0, failed: 0, retry: 0 };
		this.draining = true;
		const out = { sent: 0, failed: 0, retry: 0 };
		try {
			const now = this.deps.now();
			const due = this.deps.store.get().outbox.filter((e) => e.state === "queued" && Date.parse(e.nextAt) <= now);
			const blockedInstances = new Set<string>();
			for (const e of due) {
				if (blockedInstances.has(e.instanceId)) continue;
				const r = await this.push(e);
				if (r === "sent") out.sent++;
				else if (r === "failed") out.failed++;
				else {
					out.retry++;
					blockedInstances.add(e.instanceId); // keep order per instance
				}
			}
		} finally {
			this.draining = false;
		}
		return out;
	}

	private async push(e: OutboxEntry): Promise<"sent" | "failed" | "retry"> {
		const session = this.deps.store.get().sessions.find((s) => s.id === e.sessionId) ?? this.deps.store.get().sessions.find((s) => s.sub === e.sub);
		const api = session ? await this.deps.credentials.apiSettings(session) : undefined;
		let result: { ok: true } | { ok: false; permanent: boolean; message: string };
		if (e.kind === "callback") result = await this.callback(e);
		else if (!api) result = { ok: false, permanent: false, message: "no usable credential for this user — they must sign in again" };
		else if (e.kind === "value") {
			const p = e.payload as { taskRef: string; value: string; override?: boolean; idempotencyKey?: string };
			const r = await this.deps.flows.putValue(api, e.instanceId, p.taskRef, p.value, { overrideExistingValue: p.override, idempotencyKey: p.idempotencyKey ?? e.id });
			if (!r.ok) result = { ok: false, permanent: r.kind === "validation" || r.kind === "notFound" || r.kind === "forbidden" || r.kind === "conflict", message: r.message };
			else if (!r.data.ok) {
				// VALUE_OVERWRITE_CONFLICT: the item already holds a value; retry once with override so a corrected answer sticks
				if (r.data.code === "VALUE_OVERWRITE_CONFLICT" && !p.override) {
					const r2 = await this.deps.flows.putValue(api, e.instanceId, p.taskRef, p.value, { overrideExistingValue: true, idempotencyKey: e.id });
					result = r2.ok && r2.data.ok ? { ok: true } : { ok: false, permanent: true, message: r2.ok ? `${r2.data.code ?? ""} ${r2.data.message ?? ""}`.trim() : r2.message };
				} else result = { ok: false, permanent: true, message: `${r.data.code ?? ""} ${r.data.message ?? ""}`.trim() || "rejected" };
			} else result = { ok: true };
		} else if (e.kind === "state") {
			const p = e.payload as { taskRef: string; processingState: "Finished" | "Pending" | "InProgress" | "Failed"; source?: string; time?: string };
			const r = await this.deps.flows.patchTaskState(api, e.instanceId, p.taskRef, { processingState: p.processingState, confirmation: { source: p.source ?? "flow-voice", time: p.time } });
			result = r.ok ? { ok: true } : { ok: false, permanent: r.kind === "validation" || r.kind === "notFound" || r.kind === "forbidden" || r.kind === "conflict", message: r.message };
		} else if (e.kind === "status") {
			const p = e.payload as { action: string; extra?: Record<string, unknown> };
			const r = await this.deps.flows.setStatus(api, e.instanceId, p.action, p.extra ?? {});
			result = r.ok ? { ok: true } : { ok: false, permanent: r.kind === "validation" || r.kind === "notFound" || r.kind === "forbidden", message: r.message };
		} else result = { ok: false, permanent: true, message: `unknown outbox kind ${String((e as { kind: string }).kind)}` };

		const now = this.deps.now();
		let outcome: "sent" | "failed" | "retry";
		await this.deps.store.update((d) => {
			const row = d.outbox.find((x) => x.id === e.id);
			if (!row) return;
			row.attempts += 1;
			if (result.ok) {
				row.state = "sent";
				row.sentAt = new Date(now).toISOString();
				row.lastError = undefined;
			} else if (result.permanent || row.attempts >= MAX_ATTEMPTS) {
				row.state = "failed";
				row.lastError = result.message;
			} else {
				row.nextAt = new Date(now + backoffMs(row.attempts)).toISOString();
				row.lastError = result.message;
			}
			outcome = row.state === "sent" ? "sent" : row.state === "failed" ? "failed" : "retry";
			// keep the journal short: drop sent rows older than a day
			d.outbox = d.outbox.filter((x) => x.state !== "sent" || !x.sentAt || Date.parse(x.sentAt) > now - 86_400_000);
		});
		outcome ??= "retry";
		if (outcome === "sent") this.deps.log.info(`outbox ${e.kind} ${e.instanceId}${e.taskId ? `/${e.taskId}` : ""} sent (attempt ${e.attempts})`);
		else if (outcome === "failed") this.deps.log.error(`outbox ${e.kind} ${e.instanceId}${e.taskId ? `/${e.taskId}` : ""} FAILED permanently: ${result.ok ? "" : result.message}`);
		else this.deps.log.warn(`outbox ${e.kind} ${e.instanceId}${e.taskId ? `/${e.taskId}` : ""} retry later: ${result.ok ? "" : result.message}`);
		this.deps.onChange?.(e, outcome);
		return outcome;
	}

	private async callback(e: OutboxEntry): Promise<{ ok: true } | { ok: false; permanent: boolean; message: string }> {
		const p = e.payload as { url: string; body: unknown };
		const f = this.deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
		try {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), 8000);
			const res = await f(p.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p.body), signal: ctrl.signal });
			clearTimeout(t);
			if (res.ok) return { ok: true };
			return { ok: false, permanent: res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429, message: `HTTP ${res.status}` };
		} catch (err) {
			return { ok: false, permanent: false, message: err instanceof Error ? err.message : String(err) };
		}
	}
}
