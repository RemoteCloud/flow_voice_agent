/**
 * Live sync watcher: keeps every open run level with Maranics while the crew is talking, so an item
 * ticked in the Flow app (or written by a workflow) reaches the voice within seconds instead of at the
 * next resume.
 *
 * The Checklist API has no subscription, so this is the fallback ladder:
 *   1. an integration pushes (`POST /v1/flows/:instanceId/changed`) → `syncNow`, ~instant;
 *   2. otherwise this ticker: a stats-only read per open run (`pageSize=0`, a few hundred bytes), and
 *      the rows only once the counts move — plus one forced row read every `fullEvery` ticks, because an
 *      edited value can leave the counts exactly as they were.
 *
 * All decisions about what the diff *means* stay in `livesync.ts` (pure) and `RunEngine.applyExternal`
 * (speaks, writes). This class only decides when to look and holds the per-run bookkeeping.
 */
import type { Logger } from "../core/log.js";
import type { ApiSettings, FlowsClient } from "../maranics/FlowsClient.js";
import type { RunItem } from "../protocol.js";
import { diffExternal, statsMoved, type ExternalDiff, type FlowStats } from "./livesync.js";

export interface FlowWatcherHost {
	/** Runs to watch right now: active runs that have a Maranics instance. */
	watched(): { runId: string; instanceId: string }[];
	/** Maranics settings of the session that owns the run; undefined = nobody to read as, skip. */
	apiFor(runId: string): Promise<ApiSettings | undefined>;
	itemsOf(runId: string): RunItem[] | undefined;
	/** Apply what Flow says. Runs on the engine, may speak. */
	onDiff(runId: string, diff: ExternalDiff): Promise<void>;
}

export interface FlowWatcherDeps {
	host: FlowWatcherHost;
	flows: FlowsClient;
	log: Logger;
	now(): number;
	/** Tick length in ms; 0 disables the ticker (push-only). */
	pollMs: number;
	/** Read the rows unconditionally every N ticks even when the stats stood still. */
	fullEvery?: number;
}

interface Watch {
	stats?: FlowStats;
	ticks: number;
	errors: number;
	/** Set after a failed read: back off until then. */
	quietUntil?: number;
}

const MAX_BACKOFF_MS = 60_000;

export class FlowWatcher {
	private timer?: NodeJS.Timeout;
	private ticking = false;
	private readonly watches = new Map<string, Watch>();

	constructor(private readonly deps: FlowWatcherDeps) {}

	get enabled(): boolean {
		return this.deps.pollMs > 0;
	}

	start(): void {
		if (this.timer || !this.enabled) return;
		this.timer = setInterval(() => void this.tick(), this.deps.pollMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** A run ended: drop its bookkeeping so a later run on the same instance starts clean. */
	forget(runId: string): void {
		this.watches.delete(runId);
	}

	/** One pass over every watched run. Never runs twice at once: a slow link must not pile up reads. */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			for (const { runId, instanceId } of this.deps.host.watched()) {
				// one run must never take the ticker down with it: a run that ends mid-pass, a store write that
				// raced us, anything. An unhandled rejection in here would be a dead timer (or a dead hub).
				try {
					await this.pass(runId, instanceId);
				} catch (err) {
					this.deps.log.warn(`live sync pass for run ${runId} threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
				}
			}
			for (const runId of [...this.watches.keys()]) if (!this.deps.host.itemsOf(runId)) this.watches.delete(runId);
		} finally {
			this.ticking = false;
		}
	}

	/**
	 * Read now, whatever the ticker was going to do: an integration said this instance changed, a run
	 * resumed, an endpoint came back, or a write hit `VALUE_OVERWRITE_CONFLICT`.
	 */
	async syncNow(runId: string, instanceId: string): Promise<ExternalDiff | undefined> {
		return this.pass(runId, instanceId, true);
	}

	private async pass(runId: string, instanceId: string, force = false): Promise<ExternalDiff | undefined> {
		const w = this.watches.get(runId) ?? { ticks: 0, errors: 0 };
		this.watches.set(runId, w);
		const now = this.deps.now();
		if (!force && w.quietUntil && now < w.quietUntil) return undefined;
		w.ticks += 1;

		const items = this.deps.host.itemsOf(runId);
		if (!items) {
			this.watches.delete(runId);
			return undefined;
		}
		const api = await this.deps.host.apiFor(runId);
		if (!api) return undefined;

		const full = force || w.ticks % Math.max(1, this.deps.fullEvery ?? 10) === 0;
		if (!full) {
			const probe = await this.deps.flows.queryValues(api, instanceId, { statsOnly: true });
			if (!probe.ok) return this.failed(w, runId, probe.message);
			w.errors = 0;
			w.quietUntil = undefined;
			if (!statsMoved(w.stats, probe.data.stats)) {
				w.stats = probe.data.stats;
				return undefined;
			}
		}

		const rows = await this.deps.flows.queryValues(api, instanceId);
		if (!rows.ok) return this.failed(w, runId, rows.message);
		w.errors = 0;
		w.quietUntil = undefined;
		w.stats = rows.data.stats;
		const diff = diffExternal(items, rows.data.rows);
		if (diff.changes.length || diff.structureChanged) await this.deps.host.onDiff(runId, diff);
		return diff;
	}

	private failed(w: Watch, runId: string, message: string): undefined {
		w.errors += 1;
		const wait = Math.min(MAX_BACKOFF_MS, this.deps.pollMs * 2 ** Math.min(6, w.errors));
		w.quietUntil = this.deps.now() + wait;
		// one line per streak, not per tick: a vessel that lost the link would otherwise fill the log
		if (w.errors === 1 || w.errors % 20 === 0) this.deps.log.warn(`live sync for run ${runId} failed (${w.errors}×): ${message} — retrying in ${Math.round(wait / 1000)} s`);
		return undefined;
	}
}
