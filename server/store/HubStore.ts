/**
 * Persistent hub state: one JSON document in `/data/hub.json`, written atomically (tmp + rename)
 * after every `update()`. Same pattern as the FlowDeck hub. Audio never lands here; the audit
 * record is text (section 15 of the spec).
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { RunItem, RunState, ExchangeState } from "../protocol.js";

export interface HubUser {
	sub: string;
	email?: string;
	name?: string;
	positionId?: string;
	positionName?: string;
	/** Location from the sign-in claims: the Maranics location new flows are created at (the token decides). */
	locationId?: string;
	locationName?: string;
	firstSeenAt: string;
	lastLoginAt: string;
	logins: number;
	isAdmin: boolean;
}

/** Sealed Maranics tokens of one signed-in user (per session, not per hub — every write is attributed). */
export interface HubCredential {
	sub: string;
	accessTokenEnc: string;
	refreshTokenEnc?: string;
	idTokenEnc?: string;
	accessExp: string;
	obtainedAt: string;
	state: "ok" | "refresh_failed" | "expired";
	lastError?: string;
}

export interface HubSession {
	id: string;
	sidHash: string;
	sub: string;
	createdAt: string;
	lastSeenAt: string;
	/** Station the browser / device selected. */
	stationId?: string;
	/** "join" = bound by scanning a station QR code (the client hides the station picker); "pick" = chosen on screen. */
	stationSource?: "join" | "pick";
	deviceId?: string;
	credential?: HubCredential;
}

export interface Station {
	stationId: string;
	name: string;
	/** Free text shown before the station name on phones: "Location 1 · Bridge". Portable (stations.json). */
	location?: string;
	defaultProfile?: string | null;
	language: string;
	audioPolicy: "ptt" | "open";
	autoStartAllowed: boolean;
	verbosity?: "full" | "short" | "silent";
	/** Complete / discard may be confirmed by voice (two-step). Default true; false = screen only (spec 21.3). */
	voiceActions?: boolean;
	/** Noisy place: on phones / tablets the mic opens only while the button is held (the app has no switch of its own). */
	holdToAnswer?: boolean;
	/**
	 * What this station may do per template id. `start` = start new ones and work on open ones, `use` = only work on
	 * open ones (started elsewhere), `off` = not shown here. A station with entries offers only those templates; no entries at all → the hub-wide Start buttons list decides.
	 * `language` = the language the checklist is run in on this station (wins over the hub-wide template language).
	 */
	templates?: Record<string, StationTemplateRule>;
}

export interface LibraryTemplate {
	templateId: string;
	name: string;
	refId?: string;
	categoryName?: string;
	importedAt: string;
	items: { key: string; name: string; section?: string; type?: string }[];
}

export interface StationTemplateRule {
	access?: "start" | "use" | "off";
	language?: string;
}

/**
 * One live QR join token per station (hash only). Minting again replaces it (rotate); revoking deletes it.
 * Lives in hub.json, not in the portable stations.json, so it survives restarts but never travels to the next vessel.
 */
export interface StationJoin {
	stationId: string;
	/** sha256 hex of the `fvj_` token. */
	tokenHash: string;
	tokenHint: string;
	/** The token itself, sealed with the hub key, so Admin can show the station link and QR again at any time. */
	sealed?: string;
	createdAt: string;
	createdBy?: string;
}

export interface Device {
	deviceId: string;
	name: string;
	tokenHash: string;
	tokenHint: string;
	enrolledAt: string;
	lastSeenAt?: string;
	stationId?: string;
	kind: "pwa" | "android" | "pi" | "other";
	revoked?: boolean;
}

export interface PendingEnrollment {
	code: string;
	deviceName: string;
	kind: Device["kind"];
	requestedAt: string;
	/** Set once an admin approves; the device collects it with the code. */
	token?: string;
	deviceId?: string;
	approvedAt?: string;
}

export interface VoiceBinding {
	bindingId: string;
	dataId: string;
	spokenPrompt?: string;
	expect?: { type: string };
	phrases?: string[];
	confirmation?: "required" | "optional" | "none";
	defaultValue?: string;
}

export interface VoiceProfile {
	profileId: string;
	name: string;
	templateId?: string;
	language?: string;
	bindings: VoiceBinding[];
}

export interface EventMapping {
	on: string;
	start: string;
	station: string;
	debounceMin?: number;
	autoStart?: boolean;
	trusted?: boolean;
	lastFiredAt?: string;
}

export interface OutboxEntry {
	id: string;
	createdAt: string;
	kind: "value" | "state" | "callback" | "status";
	instanceId: string;
	taskId?: string;
	dataId?: string;
	/** Session (user) whose token is used; the write is attributed to them. */
	sessionId: string;
	sub: string;
	payload: Record<string, unknown>;
	attempts: number;
	nextAt: string;
	lastError?: string;
	state: "queued" | "sent" | "failed";
	sentAt?: string;
	runId?: string;
	promptId?: string;
}

export interface RunRecord {
	runId: string;
	stationId: string;
	instanceId: string;
	templateId?: string;
	templateName: string;
	state: RunState;
	exchange: ExchangeState;
	currentTaskId?: string;
	items: RunItem[];
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	users: { sub: string; name?: string; sessionId: string }[];
	language: string;
	verbosity: "full" | "short" | "silent";
	attempts: number;
	lastSpoken?: string;
	pendingReadback?: { taskId: string; value: string; valueText: string; transcript: string; confidence: number };
	pendingReason?: string;
	trigger?: { type: string; at?: string; source?: string };
	callbackUrl?: string;
	/** Task ids the user skipped, offered again in the sweep. */
	skipped: string[];
	/** A spoken complete / discard waiting for its confirmation. */
	pendingAction?: { kind: "complete" | "discard"; reasonCode?: string; reasonTitle?: string; step: "reason" | "confirm"; reasons?: { code: string; title: string; requireComment: boolean }[] };
	sweepOffered?: boolean;
}

export interface PromptRecord {
	promptId: string;
	createdAt: string;
	stationId: string;
	instanceId: string;
	templateId?: string;
	templateName?: string;
	item: { dataId?: string; taskId?: string; prompt: string; expect: { type: string }; language?: string; options?: { title: string; value: string }[] };
	policy: { confirmation: "required" | "none"; priority: "normal" | "high"; timeoutSec: number; retries: number };
	callbackUrl?: string;
	state: "queued" | "speaking" | "listening" | "confirming" | "committed" | "queued_offline" | "escalated" | "failed" | "cancelled";
	result?: { value?: string; transcript?: string; confidence?: number; utteredAt?: string; committedAt?: string; user?: { id: string; name?: string }; attempts: number; error?: string };
	idempotencyKey?: string;
}

export interface AuditEntry {
	at: string;
	kind: string;
	stationId?: string;
	runId?: string;
	promptId?: string;
	taskId?: string;
	dataId?: string;
	sub?: string;
	transcript?: string;
	value?: string;
	confidence?: number;
	attempts?: number;
	text?: string;
}

export interface HubData {
	version: 1;
	/** Bumped on "sign everyone out"; sessions carry the epoch they were minted with. */
	sessionEpoch: number;
	users: HubUser[];
	sessions: HubSession[];
	devices: Device[];
	pendingEnrollments: PendingEnrollment[];
	stations: Station[];
	/** Keyed by stationId. */
	stationJoins: Record<string, StationJoin>;
	profiles: VoiceProfile[];
	mappings: EventMapping[];
	runs: RunRecord[];
	prompts: PromptRecord[];
	outbox: OutboxEntry[];
	audit: AuditEntry[];
	idempotency: Record<string, { at: string; result: string }>;
	/**
	 * The central checklist register (Admin → Checklist setup): templates downloaded from the Templates app, with a snapshot of
	 * their items. Once it holds anything, only registered checklists are offered; language and trigger words are set
	 * here (`settings.templateLanguages` / `settings.itemAnswers`) and stations pick from it.
	 */
	library?: Record<string, LibraryTemplate>;
	/** Portable file → modification time it had when it was last imported; a file is imported again only after it changed. */
	portableSeen?: Record<string, number>;
	settings: { readNotices: boolean; tzMode: "utc" | "local"; confirmation: "required" | "optional"; /** Template ids that get a start button on the phone/tablet home screen and in the voice menu; empty or absent → every template. */ startable?: string[]; /** Template id → language the checklist is written in (en/sv/no/fr/de); wins over the station language. */ templateLanguages?: Record<string, string>; /** Template id → item key (`answerKey`) → words that count as that item's answer ("up", "closed"). */ itemAnswers?: Record<string, Record<string, string[]>> };
}

export function emptyData(): HubData {
	return {
		version: 1,
		sessionEpoch: 1,
		users: [],
		sessions: [],
		devices: [],
		pendingEnrollments: [],
		stations: [
			{ stationId: "bridge-01", name: "Bridge", defaultProfile: null, language: "en", audioPolicy: "ptt", autoStartAllowed: true, verbosity: "full" },
			{ stationId: "ecr-01", name: "Engine Control Room", defaultProfile: null, language: "en", audioPolicy: "ptt", autoStartAllowed: true, verbosity: "full" },
			{ stationId: "roaming", name: "Roaming — rounds", defaultProfile: null, language: "en", audioPolicy: "ptt", autoStartAllowed: false, verbosity: "short" },
		],
		stationJoins: {},
		profiles: [],
		mappings: [],
		runs: [],
		prompts: [],
		outbox: [],
		audit: [],
		idempotency: {},
		settings: { readNotices: false, tzMode: "utc", confirmation: "required" },
	};
}

export interface HubStore {
	get(): HubData;
	update(fn: (d: HubData) => void): Promise<HubData>;
}

const MAX_AUDIT = 5000;
const MAX_RUNS = 200;
const MAX_PROMPTS = 500;

function trim(d: HubData): void {
	if (d.audit.length > MAX_AUDIT) d.audit = d.audit.slice(-MAX_AUDIT);
	if (d.runs.length > MAX_RUNS) {
		const finished = d.runs.filter((r) => r.state === "completed" || r.state === "abandoned");
		const drop = new Set(finished.slice(0, d.runs.length - MAX_RUNS).map((r) => r.runId));
		d.runs = d.runs.filter((r) => !drop.has(r.runId));
	}
	if (d.prompts.length > MAX_PROMPTS) d.prompts = d.prompts.slice(-MAX_PROMPTS);
	const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
	for (const [k, v] of Object.entries(d.idempotency)) if (Date.parse(v.at) < cutoff) delete d.idempotency[k];
}

export class MemoryHubStore implements HubStore {
	private data: HubData;
	constructor(initial?: Partial<HubData>) {
		this.data = { ...emptyData(), ...(initial ?? {}) };
	}
	get(): HubData {
		return this.data;
	}
	async update(fn: (d: HubData) => void): Promise<HubData> {
		fn(this.data);
		trim(this.data);
		return this.data;
	}
}

/**
 * JSON file store. Reads on construction, writes atomically on every update. Updates are
 * serialised through a promise chain so two concurrent `update()` calls never interleave.
 */
export class JsonHubStore implements HubStore {
	private data: HubData;
	private chain: Promise<unknown> = Promise.resolve();
	readonly file: string;

	constructor(dataDir: string, private readonly log?: { warn(m: string): void; info(m: string): void }) {
		mkdirSync(dataDir, { recursive: true });
		this.file = path.join(dataDir, "hub.json");
		this.data = emptyData();
		const fresh = !existsSync(this.file);
		if (existsSync(this.file)) {
			try {
				const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<HubData>;
				this.data = { ...emptyData(), ...raw };
				// stations.json / profiles / mappings on the volume are the portable "files"; hub.json mirrors them
			} catch (err) {
				this.log?.warn(`hub.json unreadable (${err instanceof Error ? err.message : String(err)}); starting empty`);
			}
		}
		this.loadPortableFiles(dataDir, fresh);
	}

	/**
	 * A portable file is imported once per version of the file: on a fresh hub, or when the file changed since the last
	 * import. Otherwise what Admin saved (hub.json) stands, so a restart never rolls stations back to an old file.
	 */
	private changed(file: string, key: string, fresh: boolean): boolean {
		const mtime = Math.round(statSync(file).mtimeMs);
		const seen = (this.data.portableSeen ??= {});
		const before = seen[key];
		seen[key] = mtime;
		if (before === undefined) return fresh;
		return before !== mtime;
	}

	/** `stations.json`, `profiles/*.json`, `mappings.json` next to hub.json override what hub.json holds — author once, copy to the next vessel. */
	private loadPortableFiles(dataDir: string, fresh: boolean): void {
		const stationsFile = path.join(dataDir, "stations.json");
		if (existsSync(stationsFile) && this.changed(stationsFile, "stations.json", fresh)) {
			try {
				const list = JSON.parse(readFileSync(stationsFile, "utf8")) as Station[];
				if (Array.isArray(list) && list.every((x) => x && typeof x.stationId === "string")) this.data.stations = list.map((x) => ({ ...x, audioPolicy: x.audioPolicy ?? "ptt", autoStartAllowed: x.autoStartAllowed ?? false, language: x.language ?? "en" }));
			} catch (err) {
				this.log?.warn(`stations.json ignored: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const mappingsFile = path.join(dataDir, "mappings.json");
		if (existsSync(mappingsFile) && this.changed(mappingsFile, "mappings.json", fresh)) {
			try {
				const list = JSON.parse(readFileSync(mappingsFile, "utf8")) as EventMapping[];
				if (Array.isArray(list)) this.data.mappings = list.filter((m) => m && typeof m.on === "string" && typeof m.start === "string" && typeof m.station === "string");
			} catch (err) {
				this.log?.warn(`mappings.json ignored: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const profilesDir = path.join(dataDir, "profiles");
		if (existsSync(profilesDir)) {
			try {
				for (const f of readdirSync(profilesDir).filter((x: string) => x.endsWith(".json"))) {
					if (!this.changed(path.join(profilesDir, f), `profiles/${f}`, fresh)) continue;
					const p = JSON.parse(readFileSync(path.join(profilesDir, f), "utf8")) as VoiceProfile;
					if (p && typeof p.profileId === "string" && Array.isArray(p.bindings)) {
						this.data.profiles = this.data.profiles.filter((x) => x.profileId !== p.profileId);
						this.data.profiles.push(p);
					}
				}
			} catch (err) {
				this.log?.warn(`profiles/ ignored: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	get(): HubData {
		return this.data;
	}

	update(fn: (d: HubData) => void): Promise<HubData> {
		const run = async () => {
			fn(this.data);
			trim(this.data);
			const tmp = `${this.file}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.data, null, 1), "utf8");
			renameSync(tmp, this.file);
			return this.data;
		};
		const p = this.chain.then(run, run);
		this.chain = p.catch(() => undefined);
		return p;
	}
}
