/**
 * Dialogue Orchestrator: owns every run and every single-item prompt as the state machine of
 * spec section 7, journals state to the store after each transition (a restart resumes mid-run),
 * enforces timeouts / retries / confirmation, and commits through the outbox.
 *
 *   speak prompt → open mic → interpret → read back → confirm → commit → advance
 *
 * Audio devices are behind `EngineIo` (the AEP gateway): the engine only ever says "speak this",
 * "listen now", "stop listening" and receives transcripts + control words back.
 */
import type { Logger } from "../core/log.js";
import type { PolicyEnv } from "../env.js";
import type { DiscardReason, FlowDetail, FlowsClient, TemplateDetail } from "../maranics/FlowsClient.js";
import type { ChecklistPick, ExchangeState, HubEvent, HubEventType, RunItem, RunView } from "../protocol.js";
import type { Credentials } from "../store/credentials.js";
import type { HubSession, HubStore, PromptRecord, RunRecord, Station, VoiceProfile } from "../store/HubStore.js";
import { answerKey, buildItems, itemAnnouncement, nextItem, previousItem, progressOf, readinessOf, spokenNumber, startAnnouncement } from "./checklist.js";
import { CHECKBOX_CHECKED, CHECKBOX_NOT_DONE, checkboxCheckedValue, controlWord, interpret, itemNumber, readbackText, THRESHOLDS, type ControlWord, type Interpretation, type InterpretContext } from "./interpret.js";
import type { Outbox } from "./Outbox.js";
import { normLang, t as tr } from "./i18n.js";
import { grammarFor } from "./grammar.js";
import { normalizeTranscript, wordsToNumber } from "./interpret.js";

/** What the screen and the voice menu offer: `code` is the Flow reason name (the status body sends it as `reason`). */
export interface DiscardOption {
	code: string;
	title: string;
	requireComment: boolean;
}

/** Last resort when neither the template nor the tenant list can be read (Flow will still validate the name). */
export const DISCARD_REASONS: DiscardOption[] = [
	{ code: "Not applicable", title: "Not applicable", requireComment: false },
	{ code: "Unnecessary", title: "Unnecessary", requireComment: false },
	{ code: "Other", title: "Other", requireComment: true },
];

export interface EngineIo {
	/** Speak `text` on the station's endpoint. Resolves when the endpoint reports it spoke (or a fallback timer fires). */
	speak(stationId: string, promptId: string, text: string, language: string): Promise<void>;
	listen(stationId: string, promptId: string, opts: { maxMs: number; bias?: string[]; expect?: string; grammar?: string[]; language?: string }): void;
	stopListening(stationId: string): void;
	status(stationId: string, state: ExchangeState, text?: string): void;
	/** Is an audio endpoint attached to the station right now? */
	hasEndpoint(stationId: string): boolean;
	/** Language the endpoint chose in `hello` (overrides the station / profile language while it is attached). */
	endpointLanguage(stationId: string): string | undefined;
	pushRun(stationId: string, run: RunView | null): void;
	emit(event: HubEvent): void;
	/** Move the station's screens (endpoint + observers) to a page. */
	navigate(stationId: string, page: "picker" | "run", opts?: { runId?: string; stationId?: string }): void;
}

export interface EngineDeps {
	store: HubStore;
	flows: FlowsClient;
	credentials: Credentials;
	outbox: Outbox;
	log: Logger;
	now(): number;
	policy: PolicyEnv;
	io: EngineIo;
	vesselId: string;
}

export class EngineError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** The hub session is valid but holds no usable Maranics token. 403, not 401: a 401 makes the web client drop to the login screen. */
function noCredential(): EngineError {
	return new EngineError(403, "NO_CREDENTIAL", "no usable Maranics token for this session — sign out and in again");
}

interface Timers {
	listen?: NodeJS.Timeout;
	confirm?: NodeJS.Timeout;
	exchange?: NodeJS.Timeout;
}

const iso = (ms: number) => new Date(ms).toISOString();
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Background talk caught by an open mic: a longer utterance that matches nothing on an item with a narrow answer
 * set (yes/no, option, number, time). Free-text items accept anything, so they are never gated.
 */
/** Spoken control words per language, handed to the recogniser as bias (on top of the English defaults). */
const BIAS_WORDS: Record<string, string[]> = {
	sv: ["bekräfta", "okej", "utfört", "klart", "hoppa över", "säg igen", "nästa", "rättelse"],
	no: ["bekreft", "greit", "utført", "ferdig", "hopp over", "gjenta", "neste", "rettelse"],
	de: ["bestätigen", "erledigt", "fertig", "überspringen", "wiederholen", "weiter", "korrektur"],
	fr: ["confirmer", "fait", "terminé", "passer", "répéter", "suivant", "corriger"],
};

export function isSideTalk(item: RunItem, text: string, result: Interpretation): boolean {
	if (result.ok) return false;
	if (item.type === "Text" || item.type === "LongText") return false;
	if (result.reason !== "no_match") return false;
	const words = text.trim().split(/\s+/).filter(Boolean);
	return words.length >= 4;
}

export class RunEngine {
	private readonly timers = new Map<string, Timers>();
	/** Live transcript per run while a capture window is open. */
	private readonly partial = new Map<string, string>();
	/** Consecutive room-talk utterances ignored on the current item, per run: every third one gets a short reminder. */
	private readonly ignored = new Map<string, number>();
	/** Item index → section name already announced, per run. */
	private readonly lastSection = new Map<string, string | undefined>();
	private readonly speaking = new Set<string>();

	constructor(private readonly deps: EngineDeps) {}

	// ------------------------------------------------------------ views

	private record(runId: string): RunRecord {
		const r = this.deps.store.get().runs.find((x) => x.runId === runId);
		if (!r) throw new EngineError(404, "RUN_NOT_FOUND", `run ${runId} not found`);
		return r;
	}

	view(runId: string): RunView {
		return this.toView(this.record(runId));
	}

	toView(r: RunRecord): RunView {
		const p = progressOf(r.items);
		const rd = readinessOf(r.items);
		return {
			runId: r.runId,
			stationId: r.stationId,
			instanceId: r.instanceId,
			templateId: r.templateId,
			templateName: r.templateName,
			state: r.state,
			exchange: r.exchange,
			currentTaskId: r.currentTaskId,
			items: r.items,
			answered: p.answered,
			total: p.total,
			voiceTotal: rd.voiceTotal,
			needsScreen: rd.needsScreen,
			skipped: p.skipped,
			unsynced: p.unsynced,
			startedAt: r.startedAt,
			updatedAt: r.updatedAt,
			users: r.users.map((u) => ({ sub: u.sub, name: u.name })),
			lastSpoken: r.lastSpoken,
			transcript: this.partial.get(r.runId),
			pendingReadback: r.pendingReadback,
			language: r.language,
			verbosity: r.verbosity,
			pendingReason: r.pendingReason,
		};
	}

	activeRun(stationId: string): RunRecord | undefined {
		return this.deps.store.get().runs.find((r) => r.stationId === stationId && (r.state === "active" || r.state === "paused" || r.state === "pending"));
	}

	private interpretCtx(r: RunRecord, item: RunItem, utteredAt: Date): InterpretContext {
		return { utteredAt, tzMode: this.deps.store.get().settings.tzMode, timeZone: this.deps.policy.timeZone, maxPastHours: this.deps.policy.maxPastHours, options: item.options, language: normLang(r.language), answers: item.expected };
	}

	runsForUser(sub: string): RunRecord[] {
		return this.deps.store.get().runs.filter((r) => r.users.some((u) => u.sub === sub) && (r.state === "active" || r.state === "paused"));
	}

	listRuns(): RunView[] {
		return this.deps.store.get().runs.filter((r) => r.state !== "completed" && r.state !== "abandoned").map((r) => this.toView(r));
	}

	private station(stationId: string): Station {
		const s = this.deps.store.get().stations.find((x) => x.stationId === stationId);
		if (!s) throw new EngineError(404, "STATION_NOT_FOUND", `station ${stationId} not found`);
		return s;
	}

	private profileFor(templateId: string | undefined, station: Station): VoiceProfile | undefined {
		const profiles = this.deps.store.get().profiles;
		return profiles.find((p) => p.profileId === station.defaultProfile) ?? profiles.find((p) => templateId && p.templateId === templateId);
	}

	private async save(r: RunRecord): Promise<void> {
		r.updatedAt = iso(this.deps.now());
		await this.deps.store.update((d) => {
			const i = d.runs.findIndex((x) => x.runId === r.runId);
			if (i >= 0) d.runs[i] = r;
			else d.runs.push(r);
		});
		this.deps.io.pushRun(r.stationId, r.state === "completed" || r.state === "abandoned" ? null : this.toView(r));
	}

	private emit(type: HubEventType, r: RunRecord, extra: Partial<HubEvent> = {}): void {
		this.deps.io.emit({ type, at: iso(this.deps.now()), stationId: r.stationId, runId: r.runId, ...extra });
	}

	private async audit(r: RunRecord, kind: string, extra: Record<string, unknown> = {}): Promise<void> {
		await this.deps.store.update((d) => {
			d.audit.push({ at: iso(this.deps.now()), kind, stationId: r.stationId, runId: r.runId, ...extra });
		});
	}

	// ------------------------------------------------------------ picker

	async listPicks(session: HubSession, stationId: string | undefined = session.stationId): Promise<ChecklistPick[]> {
		const api = await this.deps.credentials.apiSettings(session);
		if (!api) throw noCredential();
		const flows = await this.deps.flows.listFlows(api, "Active", 1, 200);
		if (!flows.ok) {
			// Never 401 here: to the client 401 means "hub session gone" and it would bounce to the login screen
			// (and straight back, since the hub session is fine). A Maranics-side refusal is an upstream problem.
			if (flows.status === 401 || flows.status === 403) {
				this.deps.log.warn(`Maranics refused the token of ${session.sub}: ${flows.message}`);
				throw new EngineError(502, "MARANICS_UNAUTHORIZED", `Maranics rejected this session's token (${flows.message}) — the sign-in client may lack Flow API access`);
			}
			throw new EngineError(502, "MARANICS", `Maranics flows: ${flows.message}`);
		}
		const picks: ChecklistPick[] = [];
		const settings = this.deps.store.get().settings;
		const station = this.deps.store.get().stations.find((s) => s.stationId === stationId);
		const access = (templateId: string | undefined) => this.templateAccess(templateId, station);
		for (const f of flows.data.items) {
			const detail = await this.deps.flows.getFlow(api, f.flowId);
			if (!detail.ok) continue;
			const items = buildItems(detail.data, { readNotices: settings.readNotices });
			const rd = readinessOf(items);
			const p = progressOf(items);
			const running = this.deps.store.get().runs.find((r) => r.instanceId === f.flowId && (r.state === "active" || r.state === "paused"));
			picks.push({
				instanceId: f.flowId,
				templateId: f.templateId ?? "",
				templateName: f.name ?? f.templateId ?? f.flowId,
				refId: f.refId,
				state: p.answered === 0 ? "not_started" : p.answered >= p.total ? "ready_to_complete" : "in_progress",
				progress: { done: p.answered, total: p.total },
				readiness: rd.readiness,
				needsScreen: rd.needsScreen,
				lastActivity: f.createdAt,
				source: "instance",
				activeRunId: running?.runId,
				startable: access(f.templateId) !== "off",
				access: access(f.templateId),
				language: this.templateLang(f.templateId, station),
			});
		}
		const templates = await this.deps.flows.listTemplates(api);
		if (!templates.ok) this.deps.log.warn(`Maranics templates: ${templates.message}`);
		if (templates.ok) {
			for (const t of templates.data.items) {
				if (t.status && !/active/i.test(t.status)) continue;
				if (access(t.id) === "off") {
					picks.push({ templateId: t.id, templateName: t.name, refId: t.refId, state: "not_started", readiness: "partial", needsScreen: 0, source: "template", startable: false, access: "off", language: this.templateLang(t.id, station) });
					continue;
				}
				const detail = await this.deps.flows.getTemplate(api, t.id);
				let readiness: ChecklistPick["readiness"] = "partial";
				let needsScreen = 0;
				if (detail.ok) {
					const tasks = detail.data.sections.flatMap((s) => s.tasks);
					const voice = tasks.filter((x) => !x.type || /^(DateAndTime|Time|Date|Number|Checkbox|QuickSelect|Dropdown|RadioButtons|Text|LongText)$/.test(x.type)).length;
					needsScreen = tasks.length - voice;
					readiness = voice === 0 && tasks.length > 0 ? "none" : needsScreen === 0 ? "full" : "partial";
				}
				picks.push({ templateId: t.id, templateName: t.name, refId: t.refId, state: "not_started", readiness, needsScreen, source: "template", startable: access(t.id) === "start", access: access(t.id), language: this.templateLang(t.id, station) });
			}
		}
		return picks;
	}

	// ------------------------------------------------------------ start / resume

	async start(session: HubSession, p: { instanceId?: string; templateId?: string; stationId: string; runId?: string }): Promise<RunView> {
		const station = this.station(p.stationId);
		const api = await this.deps.credentials.apiSettings(session);
		if (!api) throw noCredential();
		const user = this.deps.store.get().users.find((u) => u.sub === session.sub);

		// resume a pending (triggered) run on this station, or an existing run for the instance
		let existing = p.runId ? this.record(p.runId) : undefined;
		if (!existing && p.instanceId) existing = this.deps.store.get().runs.find((r) => r.instanceId === p.instanceId && (r.state === "active" || r.state === "paused" || r.state === "pending"));
		if (!existing) {
			const pending = this.activeRun(p.stationId);
			if (pending && pending.state === "pending" && (!p.templateId || pending.templateId === p.templateId)) existing = pending;
		}
		if (existing) {
			if (existing.stationId !== p.stationId) {
				// the run moves with the user (rounds phone → ECR): end it on the old station
				existing.stationId = p.stationId;
			}
			if (!existing.users.some((u) => u.sessionId === session.id)) existing.users.push({ sub: session.sub, name: user?.name, sessionId: session.id });
			if (existing.state === "pending" && !existing.instanceId) {
				const created = await this.deps.flows.createFlow(api, existing.templateId ?? "");
				if (!created.ok) throw new EngineError(502, "MARANICS", `create checklist: ${created.message}`);
				existing.instanceId = created.data.flowId;
			}
			const wasPending = existing.state === "pending";
			await this.refreshItems(existing, api, station);
			existing.state = "active";
			existing.pendingReason = undefined;
			await this.save(existing);
			this.emit(wasPending ? "run.started" : "run.resumed", existing, { text: existing.templateName });
			await this.audit(existing, wasPending ? "run.started" : "run.resumed", { sub: session.sub, text: existing.templateName });
			await this.announceAndSpeak(existing, !wasPending);
			return this.toView(existing);
		}

		const other = this.activeRun(p.stationId);
		if (other && other.state !== "pending") throw new EngineError(409, "RUN_ACTIVE", `station ${p.stationId} already has an active run (${other.templateName})`);

		let instanceId = p.instanceId;
		if (!instanceId) {
			if (!p.templateId) throw new EngineError(400, "BAD_REQUEST", "instanceId or templateId is required");
			if (this.templateAccess(p.templateId, station) !== "start") throw new EngineError(403, "NOT_STARTABLE_HERE", `this checklist cannot be started on ${station.name}`);
			const created = await this.deps.flows.createFlow(api, p.templateId);
			if (!created.ok) throw new EngineError(502, "MARANICS", `create checklist: ${created.message}`);
			instanceId = created.data.flowId;
		}
		const detail = await this.deps.flows.getFlow(api, instanceId);
		if (!detail.ok) throw new EngineError(502, "MARANICS", `read checklist: ${detail.message}`);
		if (p.instanceId && this.templateAccess(detail.data.templateId, station) === "off") throw new EngineError(403, "NOT_USED_HERE", `this checklist is not used on ${station.name}`);
		const run = this.newRun(detail.data, station, session, user?.name, await this.templateDetail(api, detail.data.templateId));
		await this.save(run);
		this.emit("run.started", run, { text: run.templateName });
		await this.audit(run, "run.started", { sub: session.sub, text: run.templateName });
		await this.announceAndSpeak(run, false);
		return this.toView(run);
	}

	private newRun(flow: FlowDetail, station: Station, session: HubSession | undefined, userName: string | undefined, template?: TemplateDetail): RunRecord {
		const settings = this.deps.store.get().settings;
		const profile = this.profileFor(flow.templateId, station);
		const items = buildItems(flow, { profile, template, readNotices: settings.readNotices, answers: settings.itemAnswers?.[flow.templateId ?? ""] });
		const now = this.deps.now();
		return {
			runId: newId("run"),
			stationId: station.stationId,
			instanceId: flow.flowId,
			templateId: flow.templateId,
			templateName: flow.name ?? flow.templateId ?? "Checklist",
			state: "active",
			exchange: "idle",
			items,
			startedAt: iso(now),
			updatedAt: iso(now),
			users: session ? [{ sub: session.sub, name: userName, sessionId: session.id }] : [],
			language: this.templateLang(flow.templateId, station) ?? this.deps.io.endpointLanguage(station.stationId) ?? profile?.language ?? station.language ?? this.deps.policy.defaultLanguage,
			verbosity: station.verbosity ?? "full",
			attempts: 0,
			skipped: [],
		};
	}

	/** Re-read the instance so resume picks up at the first unanswered item and progress matches Flow. */
	private async refreshItems(r: RunRecord, api: NonNullable<Awaited<ReturnType<Credentials["apiSettings"]>>>, station: Station): Promise<void> {
		if (!r.instanceId) return;
		const detail = await this.deps.flows.getFlow(api, r.instanceId);
		if (!detail.ok) return;
		const profile = this.profileFor(detail.data.templateId, station);
		const fresh = buildItems(detail.data, { profile, template: await this.templateDetail(api, detail.data.templateId), readNotices: this.deps.store.get().settings.readNotices, answers: this.deps.store.get().settings.itemAnswers?.[detail.data.templateId ?? ""] });
		const local = new Map(r.items.map((i) => [i.taskId, i]));
		for (const f of fresh) {
			const l = local.get(f.taskId);
			if (!l) continue;
			// keep local knowledge Flow does not have yet: unsynced answers, skips
			if (l.state === "unsynced" && f.state !== "answered") Object.assign(f, { state: "unsynced", value: l.value, valueText: l.valueText, outboxId: l.outboxId, transcript: l.transcript, confidence: l.confidence, utteredAt: l.utteredAt });
			if (l.state === "skipped" && f.state === "unanswered") f.state = "skipped";
		}
		r.items = fresh;
		r.templateName = detail.data.name ?? r.templateName;
	}

	/** Triggered (event / webhook / MQTT) run: pending until someone says start, unless autoStart is honoured. */
	async trigger(p: { templateId: string; stationId: string; trigger: { type: string; at?: string; source?: string }; autoStart?: boolean; trusted?: boolean; callbackUrl?: string; language?: string }): Promise<RunView> {
		const station = this.station(p.stationId);
		const existing = this.activeRun(p.stationId);
		if (existing) {
			this.deps.log.info(`trigger ${p.trigger.type} ignored: station ${p.stationId} already has run ${existing.runId}`);
			return this.toView(existing);
		}
		const now = this.deps.now();
		const templateName = await this.templateName(p.templateId);
		const run: RunRecord = {
			runId: newId("run"),
			stationId: station.stationId,
			instanceId: "",
			templateId: p.templateId,
			templateName,
			state: "pending",
			exchange: "idle",
			items: [],
			startedAt: iso(now),
			updatedAt: iso(now),
			users: [],
			language: p.language ?? this.templateLang(p.templateId, station) ?? this.stationLang(station.stationId),
			verbosity: station.verbosity ?? "full",
			attempts: 0,
			skipped: [],
			trigger: p.trigger,
			callbackUrl: p.callbackUrl,
			pendingReason: tr(p.language ?? this.templateLang(p.templateId, station) ?? this.stationLang(station.stationId), "ready", { name: templateName }),
		};
		await this.save(run);
		this.emit("run.pending", run, { text: run.pendingReason });
		await this.audit(run, "run.pending", { text: `${p.trigger.type}${p.trigger.source ? ` from ${p.trigger.source}` : ""}` });
		if (this.deps.io.hasEndpoint(run.stationId)) await this.say(run, run.pendingReason ?? "");
		const canAuto = p.autoStart && p.trusted && station.autoStartAllowed;
		if (canAuto) {
			// only a signed-in endpoint can auto start (nothing is written unattributed)
			const session = this.sessionOnStation(run.stationId);
			if (session) await this.start(session, { runId: run.runId, stationId: run.stationId, templateId: p.templateId });
			else this.deps.log.warn(`autoStart for ${templateName} on ${run.stationId}: no signed-in endpoint, staying pending`);
		}
		return this.toView(this.record(run.runId));
	}

	private sessionOnStation(stationId: string): HubSession | undefined {
		const sessions = this.deps.store.get().sessions.filter((s) => s.stationId === stationId && (s.credential || s.sub.startsWith("dev:")));
		return sessions.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0];
	}

	private readonly templates = new Map<string, { at: number; detail: TemplateDetail }>();
	private tenantReasons?: { at: number; reasons: DiscardReason[] };

	/**
	 * Discard reasons Flow will accept for `templateId`: the template's own list when it has one, else the tenant-wide
	 * list, else the static fallback. Both are cached for five minutes; a failed read falls back rather than blocking.
	 */
	async discardReasons(session: HubSession, templateId: string | undefined): Promise<DiscardOption[]> {
		const api = await this.deps.credentials.apiSettings(session);
		if (!api) return DISCARD_REASONS;
		const tpl = await this.templateDetail(api, templateId);
		let reasons = tpl?.discardReasons ?? [];
		if (!reasons.length) {
			const now = Number(this.deps.now());
			if (!this.tenantReasons || now - this.tenantReasons.at >= 5 * 60_000) {
				const res = await this.deps.flows.getDiscardReasons(api);
				if (res.ok) this.tenantReasons = { at: now, reasons: res.data };
				else this.deps.log.warn(`discard reasons unavailable (${res.message}); using the built-in list`);
			}
			reasons = this.tenantReasons?.reasons ?? [];
		}
		return reasons.length ? reasons.map((x) => ({ code: x.name, title: x.name, requireComment: x.requireComment })) : DISCARD_REASONS;
	}

	/**
	 * The template behind a flow, cached briefly. The v3 flow read does not carry a checkbox's option list
	 * ("Utført::completed"), so without the template the hub would write "OK" where Flow expects "completed".
	 */
	/** Admin → Checklist setup: what the Templates app offers right now. */
	async availableTemplates(session: HubSession): Promise<{ templateId: string; name: string; refId?: string; categoryName?: string; registered: boolean }[]> {
		const api = await this.deps.credentials.apiSettings(session);
		if (!api) throw noCredential();
		const list = await this.deps.flows.listTemplates(api);
		if (!list.ok) throw new EngineError(502, "MARANICS", `Maranics templates: ${list.message}`);
		const library = this.deps.store.get().library ?? {};
		return list.data.items.map((t) => ({ templateId: t.id, name: t.name, refId: t.refId, categoryName: t.categoryName, registered: !!library[t.id] })).sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Download (or refresh) a template into the central register: name + a snapshot of its items. */
	async registerTemplate(session: HubSession, templateId: string): Promise<void> {
		const api = await this.deps.credentials.apiSettings(session);
		if (!api) throw noCredential();
		this.templates.delete(templateId);
		const t = await this.deps.flows.getTemplate(api, templateId);
		if (!t.ok) throw new EngineError(502, "MARANICS", `template: ${t.message}`);
		const items = await this.templateItems(session, templateId);
		await this.deps.store.update((d) => {
			(d.library ??= {})[templateId] = { templateId, name: t.data.name, refId: t.data.refId, categoryName: t.data.categoryName, importedAt: iso(this.deps.now()), items };
		});
	}

	/** Admin → Answers: the items of a template, with the key their answer words are stored under. */
	async templateItems(session: HubSession, templateId: string): Promise<{ key: string; name: string; section?: string; type?: string }[]> {
		const api = await this.deps.credentials.apiSettings(session);
		if (!api) throw noCredential();
		const t = await this.templateDetail(api, templateId);
		if (!t) throw new EngineError(502, "MARANICS", "template unavailable");
		return [...t.sections].sort((a, b) => a.order - b.order).flatMap((s) => [...s.tasks].sort((a, b) => a.order - b.order).map((x) => ({ key: answerKey({ dataId: x.dataId, name: x.name }), name: x.name, section: s.name, type: x.type })));
	}

	private async templateDetail(api: NonNullable<Awaited<ReturnType<Credentials["apiSettings"]>>>, templateId: string | undefined): Promise<TemplateDetail | undefined> {
		if (!templateId) return undefined;
		const hit = this.templates.get(templateId);
		const now = Number(this.deps.now());
		if (hit && now - hit.at < 5 * 60_000) return hit.detail;
		const t = await this.deps.flows.getTemplate(api, templateId);
		if (!t.ok) {
			this.deps.log.warn(`template ${templateId} unavailable (${t.message}); checkbox options unknown`);
			return hit?.detail;
		}
		this.templates.set(templateId, { at: now, detail: t.data });
		return t.data;
	}

	private async templateName(templateId: string): Promise<string> {
		const session = this.deps.store.get().sessions.find((s) => s.credential || s.sub.startsWith("dev:"));
		const api = session ? await this.deps.credentials.apiSettings(session) : undefined;
		if (api) {
			const t = await this.deps.flows.getTemplate(api, templateId);
			if (t.ok) return t.data.name;
		}
		return templateId.split("/").pop() ?? templateId;
	}

	// ------------------------------------------------------------ single-item prompts (secondary path)

	async enqueuePrompt(p: PromptRecord): Promise<PromptRecord> {
		await this.deps.store.update((d) => {
			d.prompts.push(p);
		});
		this.deps.io.emit({ type: "prompt.queued", at: iso(this.deps.now()), stationId: p.stationId, promptId: p.promptId, text: p.item.prompt });
		void this.pumpPrompts(p.stationId);
		return p;
	}

	/** Speak the next queued prompt on a station that is not mid-exchange. */
	async pumpPrompts(stationId: string): Promise<void> {
		const active = this.activeRun(stationId);
		if (active && active.state === "active" && active.exchange !== "idle") return;
		const prompt = this.deps.store
			.get()
			.prompts.filter((x) => x.stationId === stationId && x.state === "queued")
			.sort((a, b) => (a.policy.priority === b.policy.priority ? 0 : a.policy.priority === "high" ? -1 : 1))[0];
		if (!prompt) return;
		const session = this.sessionOnStation(stationId);
		if (!session) {
			this.deps.log.info(`prompt ${prompt.promptId} waits: no signed-in endpoint on ${stationId}`);
			return;
		}
		if (active && active.state === "active") {
			// inject into the active run as an ad-hoc item spoken next
			await this.injectPrompt(active, prompt);
			return;
		}
		if (active) return; // paused / pending run holds the station
		const user = this.deps.store.get().users.find((u) => u.sub === session.sub);
		const station = this.station(stationId);
		const now = this.deps.now();
		const item: RunItem = { taskId: prompt.item.taskId ?? prompt.item.dataId ?? prompt.promptId, dataId: prompt.item.dataId, index: 1, name: prompt.item.prompt.replace(/\?$/, ""), spokenPrompt: prompt.item.prompt, type: prompt.item.expect.type, options: prompt.item.options, voice: true, state: "unanswered" };
		const run: RunRecord = {
			runId: `prun_${prompt.promptId}`,
			stationId,
			instanceId: prompt.instanceId,
			templateId: prompt.templateId,
			templateName: prompt.templateName ?? "Prompt",
			state: "active",
			exchange: "idle",
			items: [item],
			startedAt: iso(now),
			updatedAt: iso(now),
			users: [{ sub: session.sub, name: user?.name, sessionId: session.id }],
			language: prompt.item.language ?? this.stationLang(station.stationId),
			verbosity: "silent",
			attempts: 0,
			skipped: [],
			callbackUrl: prompt.callbackUrl,
		};
		await this.deps.store.update((d) => {
			const x = d.prompts.find((q) => q.promptId === prompt.promptId);
			if (x) x.state = "speaking";
		});
		await this.save(run);
		await this.speakItem(run, item);
	}

	private async injectPrompt(run: RunRecord, prompt: PromptRecord): Promise<void> {
		const item: RunItem = { taskId: prompt.item.taskId ?? prompt.item.dataId ?? prompt.promptId, dataId: prompt.item.dataId, index: run.items.length + 1, name: prompt.item.prompt.replace(/\?$/, ""), spokenPrompt: prompt.item.prompt, type: prompt.item.expect.type, options: prompt.item.options, voice: true, state: "unanswered" };
		run.items.push(item);
		await this.deps.store.update((d) => {
			const x = d.prompts.find((q) => q.promptId === prompt.promptId);
			if (x) x.state = "speaking";
		});
		await this.save(run);
		await this.speakItem(run, item);
	}

	async cancelPrompt(promptId: string): Promise<boolean> {
		let found = false;
		await this.deps.store.update((d) => {
			const x = d.prompts.find((q) => q.promptId === promptId);
			if (x && (x.state === "queued" || x.state === "speaking" || x.state === "listening" || x.state === "confirming")) {
				x.state = "cancelled";
				found = true;
			}
		});
		const run = this.deps.store.get().runs.find((r) => r.runId === `prun_${promptId}` && r.state === "active");
		if (run) await this.abandon(run.runId, "cancelled");
		return found;
	}

	private async finishPrompt(run: RunRecord, item: RunItem, state: PromptRecord["state"], error?: string): Promise<void> {
		const promptId = run.runId.startsWith("prun_") ? run.runId.slice(5) : undefined;
		const prompt = this.deps.store.get().prompts.find((p) => p.state !== "cancelled" && (p.promptId === promptId || (p.stationId === run.stationId && (p.item.taskId === item.taskId || p.item.dataId === item.dataId) && (p.state === "speaking" || p.state === "listening" || p.state === "confirming"))));
		if (!prompt) return;
		const user = run.users[run.users.length - 1];
		const result: PromptRecord["result"] = { value: item.value, transcript: item.transcript, confidence: item.confidence, utteredAt: item.utteredAt, committedAt: item.committedAt, user: user ? { id: user.sub, name: user.name } : undefined, attempts: run.attempts + 1, error };
		await this.deps.store.update((d) => {
			const x = d.prompts.find((q) => q.promptId === prompt.promptId);
			if (x) {
				x.state = state;
				x.result = result;
			}
		});
		this.deps.io.emit({ type: state === "committed" ? "answer.committed" : state === "queued_offline" ? "answer.queued_offline" : state === "escalated" ? "prompt.escalated" : "prompt.failed", at: iso(this.deps.now()), stationId: run.stationId, promptId: prompt.promptId, taskId: item.taskId, text: item.valueText });
		if (prompt.callbackUrl && user) {
			await this.deps.outbox.enqueue({ kind: "callback", instanceId: run.instanceId, sessionId: user.sessionId, sub: user.sub, promptId: prompt.promptId, payload: { url: prompt.callbackUrl, body: { promptId: prompt.promptId, state, dataId: item.dataId, taskId: item.taskId, ...result, station: run.stationId } } });
		}
		if (run.runId.startsWith("prun_")) {
			run.state = "completed";
			run.completedAt = iso(this.deps.now());
			await this.save(run);
			void this.pumpPrompts(run.stationId);
		}
	}

	// ------------------------------------------------------------ speaking

	private async sayOn(stationId: string, lang: string, rawText: string): Promise<void> {
		if (!rawText) return;
		await this.deps.io.speak(stationId, newId("p"), rawText.charAt(0).toUpperCase() + rawText.slice(1), lang);
	}

	/** Admin → Start buttons: the language a template is written (and therefore spoken and answered) in. */
	private templateLang(templateId: string | undefined, station?: Station): string | undefined {
		if (!templateId) return undefined;
		return station?.templates?.[templateId]?.language ?? this.deps.store.get().settings.templateLanguages?.[templateId];
	}

	/** Station list first (Admin → Stations → Checklists on this station: only what was added), else the hub-wide Start buttons list (empty → everything). */
	templateAccess(templateId: string | undefined, station?: Station): "start" | "use" | "off" {
		const d = this.deps.store.get();
		// the central register (Admin → Checklist setup), once it holds anything, is the whole offer
		const hasLibrary = !!d.library && Object.keys(d.library).length > 0;
		if (hasLibrary && !(templateId && d.library![templateId])) return "off";
		// a station with its own list offers only what was added to it
		if (station?.templates && Object.keys(station.templates).length) return (templateId && station.templates[templateId]?.access) || (templateId && station.templates[templateId] ? "start" : "off");
		if (hasLibrary) return "start";
		return !d.settings.startable?.length || (!!templateId && d.settings.startable.includes(templateId)) ? "start" : "off";
	}

	/** The endpoint's chosen language wins over the station's configured one. */
	private stationLang(stationId: string): string {
		return this.deps.io.endpointLanguage(stationId) ?? this.deps.store.get().stations.find((x) => x.stationId === stationId)?.language ?? this.deps.policy.defaultLanguage;
	}

	/** "item four" while a run is active: jump to that spoken item. Returns false when the phrase is not a jump. */
	private async tryItemJump(r: RunRecord, text: string): Promise<boolean> {
		const n = itemNumber(text);
		if (n === undefined) return false;
		const target = r.items.find((i) => i.index === n);
		if (!target || !target.voice) {
			await this.say(r, tr(r.language, "item_unknown", { n: spokenNumber(n, r.language) }));
			const cur = r.items.find((i) => i.taskId === r.currentTaskId);
			if (cur && r.exchange !== "idle") await this.openListen(r, cur);
			return true;
		}
		this.clearTimers(r.runId);
		this.partial.delete(r.runId);
		this.deps.io.stopListening(r.stationId);
		r.pendingReadback = undefined;
		this.emit("run.item.captured", r, { taskId: target.taskId, text });
		if (target.state === "answered" || target.state === "unsynced") target.state = "unanswered";
		await this.speakItem(r, target);
		return true;
	}

	private async say(r: RunRecord, rawText: string, promptId = newId("p")): Promise<void> {
		if (!rawText) return;
		const text = rawText.charAt(0).toUpperCase() + rawText.slice(1);
		r.lastSpoken = text;
		this.speaking.add(r.runId);
		try {
			await this.deps.io.speak(r.stationId, promptId, text, r.language);
		} finally {
			this.speaking.delete(r.runId);
		}
	}

	private async announceAndSpeak(r: RunRecord, resume: boolean): Promise<void> {
		const text = startAnnouncement(r.templateName, r.items, r.verbosity, resume, r.language);
		this.lastSection.set(r.runId, undefined);
		if (text) await this.say(r, text);
		const next = nextItem(r.items);
		if (!next) {
			await this.offerSweepOrComplete(r);
			return;
		}
		await this.speakItem(r, next);
	}

	private async speakItem(r: RunRecord, item: RunItem): Promise<void> {
		const current = this.record(r.runId);
		if (current.state !== "active") return;
		for (const i of r.items) if (i.state === "current") i.state = "unanswered";
		item.state = "current";
		r.currentTaskId = item.taskId;
		r.exchange = "speaking";
		r.attempts = 0;
		r.pendingReadback = undefined;
		this.partial.delete(r.runId);
		await this.save(r);
		const prev = this.lastSection.get(r.runId);
		const first = prev === undefined && !r.items.some((i) => i.state === "answered" || i.state === "unsynced");
		const text = itemAnnouncement(item, prev, first, r.verbosity, r.language);
		this.lastSection.set(r.runId, item.sectionName);
		this.emit("run.item.spoken", r, { taskId: item.taskId, text });
		this.armExchangeTimer(r);
		await this.say(r, text, `${r.runId}:${item.taskId}`);
		await this.openListen(r, item);
	}

	private biasFor(r: RunRecord, item: RunItem): string[] {
		const lang = normLang(r.language);
		const out = ["confirm", "yes", "no", "correction", "say again", "skip", "not applicable", item.name];
		if (lang !== "en") out.push(tr(lang, "yes"), tr(lang, "no"), ...(BIAS_WORDS[lang] ?? []));
		if (item.type === "DateAndTime" || item.type === "Time") out.push("minutes ago", "now", "just now", "zero", "hundred");
		if (item.options) out.push(...item.options.map((o) => o.title));
		const station = this.deps.store.get().stations.find((s) => s.stationId === r.stationId);
		const profile = this.profileFor(r.templateId, station ?? ({} as Station));
		const b = profile?.bindings.find((x) => x.dataId === item.dataId);
		if (b?.phrases) out.push(...b.phrases);
		if (item.expected) out.push(...item.expected);
		return out;
	}

	private async openListen(r: RunRecord, item: RunItem, maxMs = this.deps.policy.listenMs): Promise<void> {
		const current = this.record(r.runId);
		if (current.state !== "active" || current.currentTaskId !== item.taskId) return;
		r.exchange = r.pendingReadback ? "confirming" : "listening";
		await this.save(r);
		this.deps.io.status(r.stationId, r.exchange, item.name);
		this.deps.io.listen(r.stationId, `${r.runId}:${item.taskId}`, { maxMs, bias: this.biasFor(r, item), expect: r.pendingReadback ? "Confirm" : item.type, grammar: grammarFor(r.language, item, this.grammarWords(r, item), !!r.pendingReadback), language: r.language });
		this.clearTimer(r.runId, "listen");
		this.clearTimer(r.runId, "confirm");
		const t = setTimeout(() => void this.onListenTimeout(r.runId), maxMs + 1500);
		t.unref?.();
		this.timerSet(r.runId).listen = t;
	}

	private timerSet(runId: string): Timers {
		let t = this.timers.get(runId);
		if (!t) {
			t = {};
			this.timers.set(runId, t);
		}
		return t;
	}

	private clearTimer(runId: string, kind: keyof Timers): void {
		const t = this.timers.get(runId);
		if (t?.[kind]) clearTimeout(t[kind]);
		if (t) t[kind] = undefined;
	}

	private clearTimers(runId: string): void {
		for (const k of ["listen", "confirm", "exchange"] as const) this.clearTimer(runId, k);
		this.timers.delete(runId);
	}

	private armExchangeTimer(r: RunRecord): void {
		this.clearTimer(r.runId, "exchange");
		const t = setTimeout(() => void this.onExchangeTimeout(r.runId), this.deps.policy.exchangeMs);
		t.unref?.();
		this.timerSet(r.runId).exchange = t;
	}

	private async onListenTimeout(runId: string): Promise<void> {
		const r = this.deps.store.get().runs.find((x) => x.runId === runId);
		if (!r || r.state !== "active" || (r.exchange !== "listening" && r.exchange !== "confirming")) return;
		if (r.pendingAction) {
			r.pendingAction = undefined;
			r.exchange = "idle";
			await this.save(r);
			await this.say(r, tr(r.language, "action_timeout"));
			const cur = r.items.find((i) => i.taskId === r.currentTaskId);
			if (cur && cur.voice) await this.speakItem(r, cur);
			return;
		}
		const item = r.items.find((i) => i.taskId === r.currentTaskId);
		if (!item) return;
		if (this.partial.get(runId)) return; // a transcript is arriving
		this.deps.io.stopListening(r.stationId);
		if (!r.runId.startsWith("prun_")) {
			// Silence is not an answer: stay on the item and keep the mic armed. Only "next item" or
			// "skip" moves on. A gentle reminder every third silent window, nothing more.
			r.attempts += 1;
			if (r.pendingReadback && r.attempts >= 2) {
				// an unconfirmed read-back that nobody answers is dropped; the item is asked again
				r.pendingReadback = undefined;
				r.attempts = 0;
			}
			if (r.attempts > 0 && r.attempts % 3 === 0) await this.say(r, tr(r.language, "waiting", { name: item.name }));
			await this.openListen(r, item);
			return;
		}
		if (r.pendingReadback) {
			await this.escalate(r, item, "no confirmation heard");
			return;
		}
		r.attempts += 1;
		if (r.attempts > this.deps.policy.retries) {
			await this.escalate(r, item, "no answer heard");
			return;
		}
		r.exchange = "clarifying";
		await this.save(r);
		this.emit("run.item.captured", r, { taskId: item.taskId, text: "" });
		await this.say(r, tr(r.language, "no_answer", { prompt: item.spokenPrompt }));
		await this.openListen(r, item);
	}

	private async onExchangeTimeout(runId: string): Promise<void> {
		const r = this.deps.store.get().runs.find((x) => x.runId === runId);
		if (!r || r.state !== "active" || r.exchange === "idle") return;
		const item = r.items.find((i) => i.taskId === r.currentTaskId);
		if (!item) return;
		if (r.runId.startsWith("prun_")) {
			await this.escalate(r, item, "exchange timed out");
			return;
		}
		this.armExchangeTimer(r);
		await this.openListen(r, item);
	}

	private async escalate(r: RunRecord, item: RunItem, reason: string): Promise<void> {
		this.clearTimers(r.runId);
		this.deps.io.stopListening(r.stationId);
		r.exchange = "escalated";
		r.pendingReadback = undefined;
		item.state = "skipped";
		item.skipReason = reason;
		if (!r.skipped.includes(item.taskId)) r.skipped.push(item.taskId);
		await this.save(r);
		this.emit("run.item.escalated", r, { taskId: item.taskId, text: reason });
		await this.audit(r, "item.escalated", { taskId: item.taskId, dataId: item.dataId, text: reason, attempts: r.attempts });
		this.deps.io.status(r.stationId, "escalated", `${item.name}: ${reason} — answer on screen`);
		if (r.runId.startsWith("prun_")) {
			await this.finishPrompt(r, item, "escalated", reason);
			return;
		}
		await this.say(r, tr(r.language, "needs_screen_moving_on", { name: item.name }));
		await this.advance(r, item);
	}

	// ------------------------------------------------------------ input

	/** Partial transcript (live display only). */
	onPartial(stationId: string, text: string): void {
		const r = this.activeRun(stationId);
		if (!r) return;
		this.partial.set(r.runId, text);
		this.deps.io.pushRun(stationId, this.toView(r));
	}

	/** The endpoint closed the capture window without a transcript (VAD silence, PTT release). STT may still deliver. */
	onListenEnd(stationId: string): void {
		const r = this.activeRun(stationId);
		if (!r || r.state !== "active") return;
		this.clearTimer(r.runId, "listen");
		const t = setTimeout(() => void this.onListenTimeout(r.runId), 4000);
		t.unref?.();
		this.timerSet(r.runId).listen = t;
	}

	/** A final transcript for the station's current exchange (from the endpoint or the STT adapter). */
	async onTranscript(stationId: string, text: string, confidence: number | undefined, session?: HubSession): Promise<void> {
		const r = this.activeRun(stationId);
		if (!r) {
			await this.onMenuTranscript(stationId, text, session ?? this.sessionOnStation(stationId));
			return;
		}
		if (r.pendingAction && r.state === "active") {
			await this.onActionAnswer(r, text, session ?? this.sessionOnStation(stationId));
			return;
		}
		if (r.state === "pending") {
			const w = controlWord(text);
			if (w === "start" || w === "confirm") {
				const s = session ?? this.sessionOnStation(stationId);
				if (s) await this.start(s, { runId: r.runId, stationId, templateId: r.templateId });
				else await this.say(r, tr(r.language, "sign_in_first"));
			}
			return;
		}
		if (r.state === "paused") {
			if (controlWord(text) === "resume") await this.resume(r.runId);
			return;
		}
		if (await this.tryItemJump(r, text)) return;
		if (r.exchange === "idle" || r.exchange === "speaking" || r.exchange === "committing") {
			// spoken run commands are valid while idle; a phrase-bound answer can arrive unprompted
			const w = controlWord(text);
			if (w) await this.handleCommand(r, w, session);
			else await this.unpromptedAnswer(r, text, confidence, session);
			return;
		}
		const item = r.items.find((i) => i.taskId === r.currentTaskId);
		if (!item) return;
		this.clearTimer(r.runId, "listen");
		this.partial.delete(r.runId);
		this.deps.io.stopListening(r.stationId);
		if (session && !r.users.some((u) => u.sessionId === session.id)) {
			const user = this.deps.store.get().users.find((u) => u.sub === session.sub);
			r.users.push({ sub: session.sub, name: user?.name, sessionId: session.id });
		}
		const utteredAt = new Date(this.deps.now());
		this.emit("run.item.captured", r, { taskId: item.taskId, text });
		const word = controlWord(text);

		if (r.pendingReadback) {
			if (word === "confirm") {
				await this.commit(r, item, r.pendingReadback, "voice");
				return;
			}
			if (word === "no" || word === "correction") {
				r.pendingReadback = undefined;
				r.exchange = "clarifying";
				await this.save(r);
				await this.say(r, item.type === "DateAndTime" || item.type === "Time" ? tr(r.language, "when", { name: item.name }) : `${item.spokenPrompt}`);
				await this.openListen(r, item);
				return;
			}
			if (word === "repeat") {
				await this.say(r, r.pendingReadback.valueText ? readbackText(item.name, item.type, { ok: true, value: r.pendingReadback.value, valueText: r.pendingReadback.valueText, confidence: r.pendingReadback.confidence, kind: "" }, r.language) : item.spokenPrompt);
				await this.openListen(r, item, this.deps.policy.confirmMs);
				return;
			}
			if (word && word !== "start") {
				await this.handleCommand(r, word, session);
				return;
			}
			// Repeating the value the hub just read back ("42" → "…, 42. Confirm?" → "42") is a confirmation, not a
			// correction: otherwise the read-back would echo forever. Any other value is a correction.
			const again = interpret(item.type, text, this.interpretCtx(r, item, utteredAt), this.phrasesFor(r, item));
			if (again.ok && (again.value === r.pendingReadback.value || again.valueText === r.pendingReadback.valueText)) {
				await this.commit(r, item, r.pendingReadback, "voice");
				return;
			}
			if (isSideTalk(item, text, again)) {
				// people talking in the room while a read-back waits: not an answer, keep waiting for one
				await this.audit(r, "item.ignored", { taskId: item.taskId, dataId: item.dataId, transcript: text, confidence, sub: session?.sub, text: "side talk during read-back" });
				await this.openListen(r, item, this.deps.policy.confirmMs);
				return;
			}
			r.pendingReadback = undefined;
		}

		// a bare "yes" / "no" while a question is open is an answer, not a command (Checkbox, Yes/No options…)
		if (word && word !== "confirm" && word !== "no") {
			await this.handleCommand(r, word, session);
			return;
		}

		r.exchange = "interpreting";
		await this.save(r);
		const result = interpret(item.type, text, this.interpretCtx(r, item, utteredAt), this.phrasesFor(r, item));
		await this.audit(r, "item.captured", { taskId: item.taskId, dataId: item.dataId, transcript: text, confidence, sub: session?.sub });
		const threshold = THRESHOLDS[item.type] ?? 0.6;
		// The phone's confidence score is a weak signal (Android reports 0.6 for a clean "ja"). An exact lexicon or
		// option hit is trusted on its own; for parsed values (times, numbers, text) only a really poor score counts.
		const exact = result.ok && (result.kind === "bool" || result.kind === "option" || result.kind === "now");
		const sttFactor = confidence === undefined || exact ? 1 : Math.max(0.8, confidence);
		if (isSideTalk(item, text, result)) {
			// a sentence that fits nothing on a yes/no, number or time item is the room, not the crew: no retry counted,
			// no "say yes or no", the mic simply re-arms. Every third one in a row earns a short reminder so a crew
			// member who is being drowned out knows the item is still open.
			const n = (this.ignored.get(r.runId) ?? 0) + 1;
			this.ignored.set(r.runId, n);
			await this.audit(r, "item.ignored", { taskId: item.taskId, dataId: item.dataId, transcript: text, confidence, sub: session?.sub, text: "side talk" });
			r.exchange = "listening";
			await this.save(r);
			if (n % 3 === 0) await this.say(r, `${result.ok ? "" : `${result.message}. `}${item.spokenPrompt}`);
			await this.openListen(r, item);
			return;
		}
		this.ignored.delete(r.runId);
		if (!result.ok || result.confidence * sttFactor < threshold) {
			r.attempts += 1;
			if (r.attempts > this.deps.policy.retries) {
				await this.escalate(r, item, result.ok ? "low confidence" : result.message);
				return;
			}
			r.exchange = "clarifying";
			await this.save(r);
			this.emit("answer.clarifying", r, { taskId: item.taskId, text: result.ok ? "low confidence" : result.message });
			await this.say(r, result.ok ? tr(r.language, "not_sure", { value: result.valueText, prompt: item.spokenPrompt }) : `${result.message}. ${item.spokenPrompt}`);
			await this.openListen(r, item);
			return;
		}
		item.transcript = text;
		item.confidence = Math.min(result.confidence, confidence ?? 1);
		item.utteredAt = utteredAt.toISOString();
		const policy = this.confirmationFor(r, item, result);
		if (policy === "none") {
			// the answer is the confirmation: repeat item and value so the crew hears what goes in, then write it
			if (!(item.type === "Checkbox" && result.value === CHECKBOX_NOT_DONE)) await this.say(r, tr(r.language, "echo", { name: item.name, value: result.valueText }));
			await this.commit(r, item, { taskId: item.taskId, value: result.value, valueText: result.valueText, transcript: text, confidence: item.confidence }, "voice");
			return;
		}
		r.pendingReadback = { taskId: item.taskId, value: result.value, valueText: result.valueText, transcript: text, confidence: item.confidence };
		r.exchange = "confirming";
		await this.save(r);
		this.emit("run.item.readback", r, { taskId: item.taskId, text: result.valueText });
		await this.say(r, readbackText(item.name, item.type, result, r.language));
		await this.openListen(r, item, this.deps.policy.confirmMs);
	}

	private phrasesFor(r: RunRecord, item: RunItem): string[] | undefined {
		const station = this.deps.store.get().stations.find((s) => s.stationId === r.stationId);
		const profile = station ? this.profileFor(r.templateId, station) : undefined;
		const b = profile?.bindings.find((x) => x.dataId === item.dataId);
		const phrases = [...(b?.phrases ?? []), item.name];
		return phrases;
	}

	/** Bound phrases plus the item's answer words: what the on-device grammar recogniser must be able to hear. */
	private grammarWords(r: RunRecord, item: RunItem): string[] {
		return [...(this.phrasesFor(r, item) ?? []), ...(item.expected ?? [])];
	}

	/**
	 * Whether a value needs a spoken "confirm" before it is written. A binding decides for its item; otherwise the
	 * hub setting: "optional" never asks (the hub repeats item and value and moves on), "required" asks only when
	 * the answer was not a plain yes/no — "yes" to "Charging plug verified?" is its own confirmation.
	 */
	private confirmationFor(r: RunRecord, item: RunItem, result: Extract<Interpretation, { ok: true }>): "required" | "none" {
		const station = this.deps.store.get().stations.find((s) => s.stationId === r.stationId);
		const profile = station ? this.profileFor(r.templateId, station) : undefined;
		const b = profile?.bindings.find((x) => x.dataId === item.dataId);
		if (b?.confirmation === "none") return "none";
		if (b?.confirmation === "required") return "required";
		if (this.deps.store.get().settings.confirmation === "optional") return "none";
		return result.kind === "bool" ? "none" : "required";
	}

	/** "Pilot on board five minutes ago" said while nothing was asked: bind by phrase to an unanswered item. */
	private async unpromptedAnswer(r: RunRecord, text: string, confidence: number | undefined, session?: HubSession): Promise<void> {
		const t = text.toLowerCase();
		const station = this.deps.store.get().stations.find((s) => s.stationId === r.stationId);
		const profile = station ? this.profileFor(r.templateId, station) : undefined;
		const candidates = r.items.filter((i) => i.voice && (i.state === "unanswered" || i.state === "skipped"));
		const hit = candidates.find((i) => {
			const b = profile?.bindings.find((x) => x.dataId === i.dataId);
			const phrases = [...(b?.phrases ?? []), i.name].map((p) => p.toLowerCase());
			return phrases.some((p) => p.length > 3 && t.startsWith(p));
		});
		if (!hit) return;
		for (const i of r.items) if (i.state === "current") i.state = "unanswered";
		hit.state = "current";
		r.currentTaskId = hit.taskId;
		r.exchange = "listening";
		await this.save(r);
		await this.onTranscript(r.stationId, text, confidence, session);
	}

	// ------------------------------------------------------------ commands

	async handleCommand(r: RunRecord, w: ControlWord, session?: HubSession): Promise<void> {
		const item = r.items.find((i) => i.taskId === r.currentTaskId);
		switch (w) {
			case "repeat":
				if (item) {
					await this.say(r, item.spokenPrompt);
					await this.openListen(r, item);
				}
				return;
			case "skip":
				if (item) await this.skip(r.runId, item.taskId, "skipped by voice");
				return;
			case "next":
				if (item && (item.state === "current" || item.state === "unanswered")) await this.skip(r.runId, item.taskId, "next item by voice");
				else if (item) await this.advance(r, item);
				return;
			case "back": {
				const prev = item ? previousItem(r.items, item.index) : undefined;
				if (prev) {
					if (item && item.state === "current") item.state = "unanswered";
					prev.state = "unanswered";
					await this.speakItem(r, prev);
				} else await this.say(r, tr(r.language, "first_item"));
				return;
			}
			case "pause":
				await this.pause(r.runId);
				return;
			case "resume":
				await this.resume(r.runId);
				return;
			case "stop":
			case "cancel":
				await this.pause(r.runId);
				await this.say(r, tr(r.language, "paused"));
				return;
			case "where": {
				const p = progressOf(r.items);
				await this.say(r, item ? tr(r.language, "where", { name: r.templateName, section: item.sectionName ? tr(r.language, "where_section", { section: item.sectionName }) : "", n: spokenNumber(item.index, r.language), item: item.name, answered: spokenNumber(p.answered, r.language), total: spokenNumber(p.total, r.language) }) : tr(r.language, "where_noitem", { name: r.templateName, answered: spokenNumber(p.answered, r.language), total: spokenNumber(p.total, r.language) }));
				if (item) await this.openListen(r, item);
				return;
			}
			case "remaining": {
				const p = progressOf(r.items);
				await this.say(r, tr(r.language, "items_left", { n: spokenNumber(Math.max(0, p.total - p.answered), r.language) }));
				if (item) await this.openListen(r, item);
				return;
			}
			case "complete":
				await this.beginComplete(r);
				return;
			case "discard":
				await this.beginDiscard(r, session);
				return;
			case "list":
			case "help":
				await this.say(r, tr(r.language, "menu_help"));
				if (item) await this.openListen(r, item);
				return;
			case "manual":
				if (item) await this.escalate(r, item, "manual entry requested");
				return;
			case "louder":
			case "slower":
				this.deps.io.status(r.stationId, r.exchange, w);
				if (item) await this.openListen(r, item);
				return;
			case "confirm":
			case "no":
			case "correction":
			case "start":
				if (item && r.exchange !== "idle") await this.openListen(r, item);
				return;
		}
		void session;
	}

	// ------------------------------------------------------------ commit / advance

	private async commit(r: RunRecord, item: RunItem, rb: NonNullable<RunRecord["pendingReadback"]>, source: "voice" | "manual"): Promise<void> {
		this.clearTimers(r.runId);
		this.deps.io.stopListening(r.stationId);
		r.exchange = "committing";
		r.pendingReadback = undefined;
		const user = r.users[r.users.length - 1];
		if (!user) {
			await this.escalate(r, item, "no signed-in user to attribute the value to");
			return;
		}
		if (item.type === "Checkbox" && rb.value === CHECKBOX_NOT_DONE) {
			// Flow knows a plain checkbox only as checked or empty, so "no" is not a value: the item stays open,
			// comes back in the skip sweep, and finally counts as "needs the screen".
			item.transcript = rb.transcript;
			item.confidence = rb.confidence;
			await this.audit(r, "item.not_done", { taskId: item.taskId, dataId: item.dataId, transcript: rb.transcript, confidence: rb.confidence, sub: user.sub, text: source });
			if (r.runId.startsWith("prun_")) {
				await this.finishPrompt(r, item, "failed", "not done");
				return;
			}
			await this.say(r, tr(r.language, "not_done", { name: item.name }));
			await this.skip(r.runId, item.taskId, "not done");
			return;
		}
		const now = this.deps.now();
		item.value = rb.value;
		item.valueText = rb.valueText;
		item.transcript = rb.transcript;
		item.confidence = rb.confidence;
		item.committedAt = iso(now);
		item.utteredAt = item.utteredAt ?? iso(now);
		item.state = "unsynced";
		this.emit("answer.confirmed", r, { taskId: item.taskId, text: rb.valueText });
		const entry = await this.deps.outbox.enqueue({
			kind: "value",
			instanceId: r.instanceId,
			taskId: item.taskId,
			dataId: item.dataId,
			sessionId: user.sessionId,
			sub: user.sub,
			runId: r.runId,
			payload: { taskRef: item.taskId, value: rb.value, idempotencyKey: `${r.runId}:${item.taskId}:${item.committedAt}`, source, transcript: rb.transcript, confidence: rb.confidence, utteredAt: item.utteredAt },
		});
		item.outboxId = entry.id;
		await this.save(r);
		await this.audit(r, "item.committed", { taskId: item.taskId, dataId: item.dataId, value: rb.value, transcript: rb.transcript, confidence: rb.confidence, sub: user.sub, attempts: r.attempts + 1, text: source });
		const drained = await this.deps.outbox.drain();
		const row = this.deps.store.get().outbox.find((o) => o.id === entry.id);
		const sent = row?.state === "sent";
		if (sent) {
			item.state = "answered";
			this.emit("run.item.committed", r, { taskId: item.taskId, text: rb.valueText });
		} else if (row?.state === "failed") {
			item.state = "skipped";
			item.skipReason = `Flow rejected the value: ${row.lastError ?? "unknown"}`;
			if (!r.skipped.includes(item.taskId)) r.skipped.push(item.taskId);
			this.emit("run.item.escalated", r, { taskId: item.taskId, text: item.skipReason });
		} else {
			this.emit("run.item.queued_offline", r, { taskId: item.taskId, text: rb.valueText });
			this.deps.io.status(r.stationId, "committing", "recorded locally, will sync");
		}
		void drained;
		await this.save(r);
		if (r.runId.startsWith("prun_")) {
			await this.finishPrompt(r, item, sent ? "committed" : row?.state === "failed" ? "failed" : "queued_offline", row?.state === "failed" ? row.lastError : undefined);
			return;
		}
		if (row?.state === "failed") await this.say(r, tr(r.language, "flow_rejected", { name: item.name }));
		else if (!sent) await this.say(r, tr(r.language, "recorded_locally"));
		else await this.say(r, tr(r.language, "confirmed")); // the crew hears that the value went in before the next item
		await this.advance(r, item);
	}

	/** Called by the outbox when an entry changes state, to flip unsynced → answered on the run. */
	async onOutboxChange(runId: string | undefined, outboxId: string, outcome: "sent" | "failed" | "retry", error?: string): Promise<void> {
		if (!runId) return;
		const r = this.deps.store.get().runs.find((x) => x.runId === runId);
		if (!r) return;
		const item = r.items.find((i) => i.outboxId === outboxId);
		if (!item || item.state !== "unsynced") return;
		if (outcome === "sent") {
			item.state = "answered";
			this.emit("run.item.committed", r, { taskId: item.taskId, text: item.valueText });
		} else if (outcome === "failed") {
			item.state = "skipped";
			item.skipReason = `Flow rejected the value: ${error ?? "unknown"}`;
			if (!r.skipped.includes(item.taskId)) r.skipped.push(item.taskId);
			this.emit("run.item.escalated", r, { taskId: item.taskId, text: item.skipReason });
		} else return;
		await this.save(r);
	}

	private async advance(r: RunRecord, from: RunItem): Promise<void> {
		const current = this.record(r.runId);
		if (current.state !== "active") return;
		if (from.state === "current") from.state = "unanswered";
		const next = nextItem(r.items, from.index);
		if (next) {
			await this.speakItem(r, next);
			return;
		}
		await this.offerSweepOrComplete(r);
	}

	private async offerSweepOrComplete(r: RunRecord): Promise<void> {
		const skipped = r.items.filter((i) => i.state === "skipped" && i.voice);
		if (skipped.length && !r.sweepOffered) {
			r.sweepOffered = true;
			r.exchange = "idle";
			r.currentTaskId = undefined;
			await this.save(r);
			await this.say(r, skipped.length === 1 ? tr(r.language, "skipped_back_one") : tr(r.language, "skipped_back", { n: spokenNumber(skipped.length, r.language) }));
			for (const i of skipped) i.state = "unanswered";
			const first = nextItem(r.items);
			if (first) {
				await this.speakItem(r, first);
				return;
			}
		}
		r.exchange = "idle";
		r.currentTaskId = undefined;
		await this.save(r);
		await this.say(r, this.completionText(r));
		this.deps.io.status(r.stationId, "idle", "ready to complete on screen");
		void this.pumpPrompts(r.stationId);
	}

	private completionText(r: RunRecord): string {
		const p = progressOf(r.items);
		const rd = readinessOf(r.items);
		const L = r.language;
		const parts: string[] = [];
		if (rd.needsScreen) parts.push(rd.needsScreen === 1 ? tr(L, "completion_screen_one") : tr(L, "completion_screen", { n: spokenNumber(rd.needsScreen, L) }));
		parts.push(tr(L, "completion_progress", { name: r.templateName, answered: spokenNumber(p.answered, L), total: spokenNumber(p.total, L) }));
		parts.push(p.answered >= p.total ? tr(L, "complete_it") : tr(L, "open_to_finish"));
		return parts.join(" ");
	}

	// ------------------------------------------------------------ voice navigation (no hands)

	private readonly menuPicks = new Map<string, ChecklistPick[]>();

	/** The checklists a signed-in user can run on this station, spoken as a numbered list. */
	async speakMenu(stationId: string, session: HubSession | undefined): Promise<void> {
		const lang = this.stationLang(stationId);
		if (!session) {
			await this.sayOn(stationId, lang, tr(lang, "sign_in_first"));
			return;
		}
		let picks: ChecklistPick[];
		try {
			picks = (await this.listPicks(session, stationId)).filter((p) => p.readiness !== "none" && p.startable !== false);
		} catch (err) {
			this.deps.log.warn(`menu: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const ordered = [...picks.filter((p) => p.source === "instance"), ...picks.filter((p) => p.source === "template")].slice(0, 8);
		this.menuPicks.set(stationId, ordered);
		if (!ordered.length) {
			await this.sayOn(stationId, lang, tr(lang, "menu_none"));
			return;
		}
		const list = ordered.map((p, i) => `${spokenNumber(i + 1, lang)}, ${p.templateName}`).join(". ");
		await this.sayOn(stationId, lang, ordered.length === 1 ? tr(lang, "menu_intro_one", { list: ordered[0].templateName }) : tr(lang, "menu_intro", { n: spokenNumber(ordered.length, lang), list }));
	}

	/** Spoken commands while no run is active: list · help · <number or name> · station <name>. */
	async onMenuTranscript(stationId: string, text: string, session: HubSession | undefined): Promise<void> {
		const lang = this.stationLang(stationId);
		const t = normalizeTranscript(text);
		if (!t) return;
		const w = controlWord(t);
		if (w === "list" || w === "help" || w === "repeat") {
			await this.speakMenu(stationId, session);
			return;
		}
		const st = t.match(/^(?:station|stasjon|estación|poste)\s+(.+)$/);
		if (st) {
			// the station comes from the station link / QR only: nothing in the client, spoken or tapped, changes it
			await this.sayOn(stationId, lang, tr(lang, "station_fixed"));
			return;
		}
		if (!session) {
			await this.sayOn(stationId, lang, tr(lang, "sign_in_first"));
			return;
		}
		let picks = this.menuPicks.get(stationId);
		if (!picks) {
			await this.speakMenu(stationId, session);
			picks = this.menuPicks.get(stationId) ?? [];
		}
		const pick = this.matchPick(t, picks, w === "start" || w === "confirm");
		if (!pick) {
			if (w) return; // an unrelated control word ("no", "pause"…) means nothing here
			await this.sayOn(stationId, lang, tr(lang, "menu_nomatch"));
			return;
		}
		await this.sayOn(stationId, lang, tr(lang, "starting_pick", { name: pick.templateName }));
		try {
			const run = await this.start(session, { instanceId: pick.instanceId, templateId: pick.instanceId ? undefined : pick.templateId, stationId, runId: pick.activeRunId });
			this.deps.io.navigate(stationId, "run", { runId: run.runId });
		} catch (err) {
			this.deps.log.warn(`menu start failed: ${err instanceof Error ? err.message : String(err)}`);
			await this.sayOn(stationId, lang, err instanceof EngineError ? err.message : tr(lang, "menu_nomatch"));
		}
	}

	private matchStation(name: string): Station | undefined {
		const n = normalizeTranscript(name);
		const stations = this.deps.store.get().stations;
		return stations.find((s) => normalizeTranscript(s.name) === n || s.stationId.toLowerCase() === n) ?? stations.find((s) => normalizeTranscript(s.name).includes(n) || n.includes(normalizeTranscript(s.name).split(/[ —-]/)[0]));
	}

	private matchPick(t: string, picks: ChecklistPick[], startWord: boolean): ChecklistPick | undefined {
		if (!picks.length) return undefined;
		if (startWord && picks.length === 1) return picks[0];
		const numText = t.replace(/^(start|starta|begin|number|nummer|numéro|numero|alternativ|option|choice|choix|checklist|checklista|sjekkliste|liste|checkliste)\s+/, "");
		const n = wordsToNumber(numText);
		if (n !== undefined && Number.isInteger(n) && n >= 1 && n <= picks.length) return picks[n - 1];
		const words = new Set(t.replace(/^(start|starta|begin|commencer|starten|run|kjør|kör)\s+/, "").split(" ").filter((x) => x.length > 2));
		let best: { p: ChecklistPick; score: number } | undefined;
		for (const p of picks) {
			const nameWords = normalizeTranscript(p.templateName).split(" ").filter((x) => x.length > 2);
			if (!nameWords.length) continue;
			const hits = nameWords.filter((x) => words.has(x)).length;
			const score = hits / nameWords.length + (t.includes(normalizeTranscript(p.templateName)) ? 1 : 0);
			if (score > 0 && (!best || score > best.score)) best = { p, score };
		}
		return best && best.score >= 0.5 ? best.p : undefined;
	}

	private voiceActionsAllowed(r: RunRecord): boolean {
		const st = this.deps.store.get().stations.find((s) => s.stationId === r.stationId);
		return st?.voiceActions !== false;
	}

	private async listenAction(r: RunRecord): Promise<void> {
		r.exchange = "confirming";
		await this.save(r);
		this.deps.io.status(r.stationId, "confirming", r.pendingAction?.kind);
		this.deps.io.listen(r.stationId, `${r.runId}:action`, { maxMs: this.deps.policy.confirmMs, expect: "Confirm", language: r.language });
		this.clearTimer(r.runId, "listen");
		const t = setTimeout(() => void this.onListenTimeout(r.runId), this.deps.policy.confirmMs + 1500);
		t.unref?.();
		this.timerSet(r.runId).listen = t;
	}

	private async beginComplete(r: RunRecord): Promise<void> {
		const p = progressOf(r.items);
		if (p.answered < p.total) {
			await this.say(r, tr(r.language, "complete_blocked_items", { n: spokenNumber(p.total - p.answered, r.language) }));
			return;
		}
		const pending = this.deps.outbox.pending(r.instanceId).length;
		if (pending) {
			await this.say(r, tr(r.language, "complete_blocked_sync", { n: spokenNumber(pending, r.language) }));
			return;
		}
		if (!this.voiceActionsAllowed(r)) {
			await this.say(r, tr(r.language, "complete_on_screen"));
			return;
		}
		this.clearTimers(r.runId);
		this.deps.io.stopListening(r.stationId);
		r.pendingAction = { kind: "complete", step: "confirm" };
		await this.say(r, tr(r.language, "complete_confirm", { name: r.templateName, answered: spokenNumber(p.answered, r.language), total: spokenNumber(p.total, r.language) }));
		await this.listenAction(r);
	}

	private async beginDiscard(r: RunRecord, session: HubSession | undefined): Promise<void> {
		if (!this.voiceActionsAllowed(r)) {
			await this.say(r, tr(r.language, "discard_on_screen"));
			return;
		}
		this.clearTimers(r.runId);
		this.deps.io.stopListening(r.stationId);
		const reasons = session ? await this.discardReasons(session, r.templateId) : DISCARD_REASONS;
		r.pendingAction = { kind: "discard", step: "reason", reasons };
		const list = reasons.map((x, i) => `${spokenNumber(i + 1, r.language)}, ${x.title}`).join(". ");
		await this.say(r, tr(r.language, "discard_reasons", { name: r.templateName, list }));
		await this.listenAction(r);
	}

	private async onActionAnswer(r: RunRecord, text: string, session: HubSession | undefined): Promise<void> {
		const a = r.pendingAction;
		if (!a) return;
		this.clearTimer(r.runId, "listen");
		this.deps.io.stopListening(r.stationId);
		const t = normalizeTranscript(text);
		const w = controlWord(t);
		const cancel = async () => {
			r.pendingAction = undefined;
			r.exchange = "idle";
			await this.save(r);
			await this.say(r, tr(r.language, "action_cancelled"));
			const cur = r.items.find((i) => i.taskId === r.currentTaskId);
			if (cur && cur.voice) await this.speakItem(r, cur);
		};
		if (w === "no" || w === "cancel" || w === "stop") {
			await cancel();
			return;
		}
		if (a.kind === "discard" && a.step === "reason") {
			const n = wordsToNumber(t.replace(/^(reason|orsak|årsak|motif|grund|number|nummer)\s+/, ""));
			const options = a.reasons?.length ? a.reasons : DISCARD_REASONS;
			const byNum = n !== undefined && Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : undefined;
			const byName = options.find((x) => t.includes(normalizeTranscript(x.title)) || normalizeTranscript(x.title).includes(t));
			const reason = byNum ?? byName;
			if (!reason) {
				const list = options.map((x, i) => `${spokenNumber(i + 1, r.language)}, ${x.title}`).join(". ");
				await this.say(r, tr(r.language, "discard_reasons", { name: r.templateName, list }));
				await this.listenAction(r);
				return;
			}
			a.reasonCode = reason.code;
			a.reasonTitle = reason.title;
			a.step = "confirm";
			await this.save(r);
			await this.say(r, tr(r.language, "discard_confirm", { name: r.templateName, reason: reason.title }));
			await this.listenAction(r);
			return;
		}
		const confirmed = w === "confirm" || /\b(confirm|bekräfta|bekreft|confirmer|bestätigen|bestätige)\b/.test(t);
		if (!confirmed) {
			await this.say(r, a.kind === "complete" ? tr(r.language, "complete_confirm", { name: r.templateName, answered: spokenNumber(progressOf(r.items).answered, r.language), total: spokenNumber(progressOf(r.items).total, r.language) }) : tr(r.language, "discard_confirm", { name: r.templateName, reason: a.reasonTitle ?? "" }));
			await this.listenAction(r);
			return;
		}
		if (!session) {
			await this.say(r, tr(r.language, "sign_in_first"));
			await cancel();
			return;
		}
		r.pendingAction = undefined;
		await this.save(r);
		try {
			if (a.kind === "complete") await this.complete(r.runId, session);
			else await this.discard(r.runId, session, a.reasonCode ?? "other");
		} catch (err) {
			await this.say(r, err instanceof EngineError ? err.message : String(err));
			r.exchange = "idle";
			await this.save(r);
		}
	}

	// ------------------------------------------------------------ integration helpers (REST /v1)

	/** An item of the run by task id or DataId (the API accepts both, like Flow's `taskRef`). */
	resolveItem(runId: string, ref: string): RunItem | undefined {
		const r = this.record(runId);
		return r.items.find((i) => i.taskId === ref) ?? r.items.find((i) => i.dataId === ref) ?? r.items.find((i) => i.dataId?.toLowerCase() === ref.toLowerCase());
	}

	/** The session that acts on Maranics for this run: its last user, else whoever is signed in on the station. */
	actingSession(runId: string): HubSession | undefined {
		const r = this.record(runId);
		const sessions = this.deps.store.get().sessions;
		for (let i = r.users.length - 1; i >= 0; i--) {
			const s = sessions.find((x) => x.id === r.users[i].sessionId);
			if (s) return s;
		}
		return this.sessionOnStation(r.stationId);
	}

	/**
	 * Start (or resume) a run from an integration: uses the user signed in on the station. Without one
	 * the run is created pending and announced, exactly like a vessel-event trigger. `item` jumps to a
	 * specific task (id or DataId) once the run is active.
	 */
	async startFromService(p: { stationId: string; instanceId?: string; templateId?: string; item?: string; source?: string; callbackUrl?: string; language?: string }): Promise<{ run: RunView; started: boolean }> {
		const session = this.sessionOnStation(p.stationId);
		if (!session) {
			if (!p.templateId) throw new EngineError(409, "NO_USER", `nobody is signed in on ${p.stationId}; pass templateId to queue a pending run instead`);
			const run = await this.trigger({ templateId: p.templateId, stationId: p.stationId, trigger: { type: "api.start", source: p.source }, callbackUrl: p.callbackUrl, language: p.language });
			return { run, started: false };
		}
		const run = await this.start(session, { instanceId: p.instanceId, templateId: p.templateId, stationId: p.stationId });
		this.deps.io.navigate(p.stationId, "run", { runId: run.runId });
		if (p.item) {
			const it = this.resolveItem(run.runId, p.item);
			if (!it) throw new EngineError(404, "ITEM_NOT_FOUND", `no item ${p.item} in ${run.templateName}`);
			if (it.voice) return { run: await this.jumpTo(run.runId, it.taskId), started: true };
		}
		return { run: this.view(run.runId), started: true };
	}

	/** Advance past the current item from the API (unanswered items are skipped and swept later). */
	async next(runId: string): Promise<RunView> {
		const r = this.record(runId);
		if (r.state !== "active") throw new EngineError(409, "RUN_NOT_ACTIVE", "run is not active");
		await this.handleCommand(r, "next");
		return this.view(runId);
	}

	// ------------------------------------------------------------ manual / screen actions

	async answerManual(runId: string, taskId: string, value: string, session: HubSession, valueText?: string): Promise<RunView> {
		const r = this.record(runId);
		if (r.state === "completed" || r.state === "abandoned") throw new EngineError(409, "RUN_ENDED", "run has ended");
		const item = r.items.find((i) => i.taskId === taskId);
		if (!item) throw new EngineError(404, "ITEM_NOT_FOUND", "item not in this run");
		if (!r.users.some((u) => u.sessionId === session.id)) {
			const user = this.deps.store.get().users.find((u) => u.sub === session.sub);
			r.users.push({ sub: session.sub, name: user?.name, sessionId: session.id });
		}
		const wasCurrent = r.currentTaskId === taskId;
		if (wasCurrent) {
			this.clearTimers(r.runId);
			this.deps.io.stopListening(r.stationId);
		}
		item.utteredAt = iso(this.deps.now());
		if (item.type === "Checkbox") {
			// the screen sends "true" / "false"; Flow wants "OK" (or the option key) / nothing
			const checked = checkboxCheckedValue(item.options);
			if (value === "true" || value === "yes" || value === CHECKBOX_CHECKED || value === checked.value) {
				value = checked.value;
				valueText = valueText ?? checked.title ?? "yes";
			} else if (value === "false" || value === "no" || value === CHECKBOX_NOT_DONE) {
				value = CHECKBOX_NOT_DONE;
				valueText = valueText ?? "no";
			}
		}
		const text = valueText ?? (value === CHECKBOX_CHECKED || value === "true" ? "yes" : value === "false" || (item.type === "Checkbox" && value === CHECKBOX_NOT_DONE) ? "no" : item.options?.find((o) => o.value === value)?.title ?? value);
		if (wasCurrent && r.state === "active") {
			await this.commit(r, item, { taskId, value, valueText: text, transcript: "", confidence: 1 }, "manual");
			return this.view(runId);
		}
		if (item.type === "Checkbox" && value === CHECKBOX_NOT_DONE) {
			// "no" on a checkbox is not a value Flow can store: the item stays open
			await this.audit(r, "item.not_done", { taskId, dataId: item.dataId, transcript: "", confidence: 1, sub: session.sub, text: "manual" });
			return this.skip(runId, taskId, "not done");
		}
		// answer out of order: commit without touching the spoken flow
		const user = r.users[r.users.length - 1];
		const now = this.deps.now();
		item.value = value;
		item.valueText = text;
		item.transcript = "";
		item.confidence = 1;
		item.committedAt = iso(now);
		item.state = "unsynced";
		const entry = await this.deps.outbox.enqueue({ kind: "value", instanceId: r.instanceId, taskId, dataId: item.dataId, sessionId: user.sessionId, sub: user.sub, runId: r.runId, payload: { taskRef: taskId, value, idempotencyKey: `${r.runId}:${taskId}:${item.committedAt}`, source: "manual", override: true } });
		item.outboxId = entry.id;
		r.skipped = r.skipped.filter((x) => x !== taskId);
		await this.save(r);
		await this.audit(r, "item.committed", { taskId, dataId: item.dataId, value, sub: session.sub, text: "manual" });
		await this.deps.outbox.drain();
		const row = this.deps.store.get().outbox.find((o) => o.id === entry.id);
		if (row?.state === "sent") item.state = "answered";
		else if (row?.state === "failed") {
			item.state = "unanswered";
			await this.save(r);
			throw new EngineError(422, "VALUE_REJECTED", row.lastError ?? "Flow rejected the value");
		}
		await this.save(r);
		return this.view(runId);
	}

	async skip(runId: string, taskId: string | undefined, reason: string): Promise<RunView> {
		const r = this.record(runId);
		const item = r.items.find((i) => i.taskId === (taskId ?? r.currentTaskId));
		if (!item) throw new EngineError(404, "ITEM_NOT_FOUND", "no current item");
		this.clearTimers(r.runId);
		this.deps.io.stopListening(r.stationId);
		item.state = "skipped";
		item.skipReason = reason;
		r.pendingReadback = undefined;
		if (!r.skipped.includes(item.taskId)) r.skipped.push(item.taskId);
		await this.save(r);
		this.emit("run.item.skipped", r, { taskId: item.taskId, text: reason });
		await this.audit(r, "item.skipped", { taskId: item.taskId, dataId: item.dataId, text: reason });
		if (r.state === "active" && r.currentTaskId === item.taskId) await this.advance(r, item);
		return this.view(runId);
	}

	async jumpTo(runId: string, taskId: string): Promise<RunView> {
		const r = this.record(runId);
		const item = r.items.find((i) => i.taskId === taskId);
		if (!item || !item.voice) throw new EngineError(400, "NOT_VOICE", "item cannot be spoken");
		if (r.state !== "active") throw new EngineError(409, "RUN_NOT_ACTIVE", "run is not active");
		this.clearTimers(r.runId);
		this.deps.io.stopListening(r.stationId);
		if (item.state === "answered" || item.state === "unsynced") item.state = "unanswered";
		await this.speakItem(r, item);
		return this.view(runId);
	}

	async repeat(runId: string): Promise<RunView> {
		const r = this.record(runId);
		await this.handleCommand(r, "repeat");
		return this.view(runId);
	}

	async pause(runId: string): Promise<RunView> {
		const r = this.record(runId);
		if (r.state !== "active") return this.view(runId);
		this.clearTimers(r.runId);
		this.deps.io.stopListening(r.stationId);
		r.state = "paused";
		r.exchange = "idle";
		r.pendingReadback = undefined;
		for (const i of r.items) if (i.state === "current") i.state = "unanswered";
		await this.save(r);
		this.emit("run.paused", r);
		await this.audit(r, "run.paused");
		return this.view(runId);
	}

	async resume(runId: string, session?: HubSession): Promise<RunView> {
		const r = this.record(runId);
		if (r.state === "completed" || r.state === "abandoned") throw new EngineError(409, "RUN_ENDED", "run has ended");
		if (session && !r.users.some((u) => u.sessionId === session.id)) {
			const user = this.deps.store.get().users.find((u) => u.sub === session.sub);
			r.users.push({ sub: session.sub, name: user?.name, sessionId: session.id });
		}
		r.state = "active";
		await this.save(r);
		this.emit("run.resumed", r);
		const next = nextItem(r.items);
		if (next) await this.speakItem(r, next);
		else await this.offerSweepOrComplete(r);
		return this.view(runId);
	}

	/** Explicit, on-screen. Blocked while anything for the instance sits unsynced. */
	async complete(runId: string, session: HubSession): Promise<RunView> {
		const r = this.record(runId);
		const pending = this.deps.outbox.pending(r.instanceId);
		if (pending.length) throw new EngineError(409, "OUTBOX_PENDING", `${pending.length} value(s) not yet synced to Flow — wait for the link, then complete`);
		const p = progressOf(r.items);
		if (p.answered < p.total) throw new EngineError(409, "ITEMS_OPEN", `${p.total - p.answered} item(s) still open`);
		const api = await this.deps.credentials.apiSettings(session);
		if (!api) throw noCredential();
		const res = await this.deps.flows.setStatus(api, r.instanceId, "complete");
		if (!res.ok) throw new EngineError(res.status === 422 ? 422 : 502, "MARANICS", `complete checklist: ${res.message}`);
		this.clearTimers(r.runId);
		this.deps.io.stopListening(r.stationId);
		r.state = "completed";
		r.exchange = "idle";
		r.completedAt = iso(this.deps.now());
		await this.save(r);
		this.emit("run.completed", r, { text: `${p.answered} of ${p.total}` });
		await this.audit(r, "run.completed", { sub: session.sub, text: `${p.answered}/${p.total}` });
		await this.say(r, tr(r.language, "completed", { name: r.templateName, answered: spokenNumber(p.answered, r.language), total: spokenNumber(p.total, r.language) }));
		await this.runCallback(r, "completed");
		this.deps.io.navigate(r.stationId, "picker");
		void this.pumpPrompts(r.stationId);
		void this.speakMenu(r.stationId, session);
		return this.toView(r);
	}

	async discard(runId: string, session: HubSession, reasonCode: string, comment?: string): Promise<RunView> {
		const r = this.record(runId);
		const api = await this.deps.credentials.apiSettings(session);
		if (!api) throw noCredential();
		if (r.instanceId) {
			// v3 accepts exactly {action, reason, comment, force}; `reason` is the discard reason's name (template list or tenant list).
			const res = await this.deps.flows.setStatus(api, r.instanceId, "discard", comment ? { reason: reasonCode, comment } : { reason: reasonCode });
			if (!res.ok) {
				this.deps.log.warn(`discard of ${r.instanceId} (${reasonCode}) refused by Flow: ${res.message}`);
				throw new EngineError(res.status === 422 ? 422 : 502, "MARANICS", `discard checklist: ${res.message}`);
			}
		}
		await this.abandon(runId, `discarded: ${reasonCode}`);
		await this.audit(r, "run.discarded", { sub: session.sub, text: `${reasonCode}${comment ? ` — ${comment}` : ""}` });
		return this.view(runId);
	}

	async abandon(runId: string, reason: string): Promise<RunView> {
		const r = this.record(runId);
		this.clearTimers(r.runId);
		this.deps.io.stopListening(r.stationId);
		r.state = "abandoned";
		r.exchange = "idle";
		r.pendingReadback = undefined;
		r.completedAt = iso(this.deps.now());
		await this.save(r);
		this.emit("run.abandoned", r, { text: reason });
		await this.runCallback(r, "abandoned");
		this.deps.io.navigate(r.stationId, "picker");
		void this.pumpPrompts(r.stationId);
		return this.toView(r);
	}

	private async runCallback(r: RunRecord, state: "completed" | "abandoned"): Promise<void> {
		if (!r.callbackUrl) return;
		const user = r.users[r.users.length - 1];
		const p = progressOf(r.items);
		await this.deps.outbox.enqueue({
			kind: "callback",
			instanceId: r.instanceId,
			sessionId: user?.sessionId ?? "",
			sub: user?.sub ?? "",
			runId: r.runId,
			payload: { url: r.callbackUrl, body: { runId: r.runId, state, templateId: r.templateId, instanceId: r.instanceId, station: r.stationId, startedAt: r.startedAt, endedAt: r.completedAt, answered: p.answered, total: p.total, skipped: r.items.filter((i) => i.state === "skipped").map((i) => i.taskId), users: r.users.map((u) => ({ id: u.sub, name: u.name })), trigger: r.trigger } },
		});
	}

	/** After a restart: no timers exist; put every active run back to a clean waiting state. */
	async recover(): Promise<void> {
		for (const r of this.deps.store.get().runs) {
			if (r.state === "active" && r.exchange !== "idle") {
				r.exchange = "idle";
				r.pendingReadback = undefined;
				for (const i of r.items) if (i.state === "current") i.state = "unanswered";
				await this.save(r);
				this.deps.log.info(`run ${r.runId} (${r.templateName}) recovered; it continues when the station's endpoint reconnects`);
			}
		}
	}

	/** The station's endpoint (re)connected: continue an active run from the next item. */
	async onEndpointReady(stationId: string, session?: HubSession): Promise<void> {
		const r = this.activeRun(stationId);
		const lang = this.deps.io.endpointLanguage(stationId);
		if (r && lang && r.language !== lang) {
			r.language = lang; // the phone switched language: the rest of the run follows it
			await this.save(r);
		}
		if (!r) {
			void this.pumpPrompts(stationId);
			const s = session ?? this.sessionOnStation(stationId);
			if (s) await this.speakMenu(stationId, s);
			return;
		}
		if (r.state === "pending") {
			await this.say(r, r.pendingReason ?? tr(r.language, "ready", { name: r.templateName }));
			return;
		}
		if (r.state === "active" && r.exchange === "idle" && !this.speaking.has(r.runId)) {
			const next = nextItem(r.items);
			if (next) await this.speakItem(r, next);
		}
	}

	async onEndpointLost(stationId: string): Promise<void> {
		const r = this.activeRun(stationId);
		if (!r || r.state !== "active") return;
		this.clearTimers(r.runId);
		if (r.exchange !== "idle") {
			r.exchange = "idle";
			r.pendingReadback = undefined;
			for (const i of r.items) if (i.state === "current") i.state = "unanswered";
			await this.save(r);
		}
	}

	/** `Interpretation` re-exported for the HTTP layer's manual-value preview. */
	preview(type: string, text: string, options?: { title: string; value: string }[], answers?: string[]): Interpretation {
		return interpret(type, text, { utteredAt: new Date(this.deps.now()), tzMode: this.deps.store.get().settings.tzMode, timeZone: this.deps.policy.timeZone, maxPastHours: this.deps.policy.maxPastHours, options, language: normLang(this.deps.policy.defaultLanguage), answers });
	}
}
