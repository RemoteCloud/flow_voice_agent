/**
 * Flow Voice shared contract (hub ↔ web ↔ Android agent). SDK-free; imported by the server and the
 * web app (relative import), and mirrored by hand in the Android app.
 *
 * Two WebSockets, both on the hub's single port:
 *   /v1/events  — run + prompt events for observers (cookie session or device token)
 *   /v1/audio   — Audio Endpoint Protocol (AEP): the one active audio endpoint of a station
 */

export const PROTOCOL_VERSION = 1;
export const DEVICE_TOKEN_PREFIX = "fvd_";
/** Station QR join tokens (`POST /api/auth/join`). */
export const JOIN_TOKEN_PREFIX = "fvj_";
/** Alias for the crypto helpers copied from the FlowDeck hub. */
export const DECK_TOKEN_PREFIX = DEVICE_TOKEN_PREFIX;

/** Voice-eligible Maranics control types (section 8 of the spec). */
export const VOICE_TYPES = ["DateAndTime", "Time", "Date", "Number", "Checkbox", "QuickSelect", "Dropdown", "RadioButtons", "Text", "LongText"] as const;
export type VoiceType = (typeof VOICE_TYPES)[number];
/** Tasks that are shown but carry no answer. */
export const INFO_TYPES = ["Information", "RichText"] as const;

export type ControlTypeName = VoiceType | "Sign" | "Drawing" | "Picture" | "File" | "AudioRecording" | "List" | "Form" | "GPS" | "ScanLabel" | "Email" | "PhoneNumber" | "PersonsOnBoard" | "DataRegister" | "SystemLists" | "DataList" | "Information" | "RichText" | (string & {});

export function isVoiceType(t: string | undefined): t is VoiceType {
	return !!t && (VOICE_TYPES as readonly string[]).includes(t);
}
export function isInfoType(t: string | undefined): boolean {
	return !!t && (INFO_TYPES as readonly string[]).includes(t);
}

// ---------------------------------------------------------------- run model

export type RunState = "pending" | "active" | "paused" | "completed" | "abandoned";
export type ItemState = "unanswered" | "current" | "answered" | "skipped" | "needs_screen" | "info" | "unsynced";
export type ExchangeState = "idle" | "speaking" | "listening" | "interpreting" | "confirming" | "committing" | "clarifying" | "escalated" | "waiting";

export interface RunItem {
	/** Maranics task id. */
	taskId: string;
	dataId?: string;
	controlId?: string;
	sectionId?: string;
	sectionName?: string;
	/** 1-based position in the spoken order. */
	index: number;
	name: string;
	spokenPrompt: string;
	type: ControlTypeName;
	options?: { title: string; value: string }[];
	voice: boolean;
	state: ItemState;
	/** Display form of the committed / pending value. */
	valueText?: string;
	value?: string;
	transcript?: string;
	confidence?: number;
	utteredAt?: string;
	committedAt?: string;
	outboxId?: string;
	skipReason?: string;
	/** Words set in Admin → Answers: an answer that contains one of them counts as the answer for this item. A word
	 * written "a + b" is a combination: every part must be heard, in any order. */
	expected?: string[];
	/** Words set in Admin → Checklist setup that name *and* set this item when the crew says them out of turn. */
	triggers?: TriggerSpec;
	/**
	 * The hub is deliberately asking this item again although Flow holds a value for it (someone jumped to it,
	 * or it came back in the sweep). Live sync leaves such an item alone until it is answered again — otherwise
	 * the value already in Flow would take the question away the moment it was asked.
	 */
	reasking?: boolean;
}

/**
 * The trigger words of one item: the words that name it when it is spoken out of turn, and set it on their own.
 * `need` = how many of them must be heard (1 = any one, `words.length` = all of them); order never matters.
 * Each word may itself be a combination ("hivt + körbro"), just like an answer word.
 */
export interface TriggerSpec {
	words: string[];
	need: number;
}

/** How a station answers: the hub asking item by item, the crew speaking trigger words, or both at once. */
export type VoiceMode = "prompt" | "trigger" | "both";

/**
 * Hardware buttons of a station (Admin → Stations → Buttons): a Bluetooth or USB button that the computer or tablet
 * sees as a keyboard key. Up to three, each bound to one action. `key` is the key the button sends, by its DOM
 * `KeyboardEvent.code` name ("Enter", "PageDown", "AudioVolumeUp"); the Android agent maps its key codes to the same
 * names, so one setting works on a laptop and a tablet. "" = not bound to a key yet.
 */
export const BUTTON_ACTIONS = ["accept", "no", "override", "next", "back", "repeat", "talk", "pause"] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];
export const MAX_STATION_BUTTONS = 3;
export interface StationButton {
	key: string;
	/** One press. */
	action: ButtonAction;
	/** Two quick presses (within `BUTTON_DOUBLE_MS`); setting it makes a single press wait that long. Never "talk". */
	double?: ButtonAction;
	/** Held down for `BUTTON_HOLD_MS`: runs while still held, the release then does nothing. Never "talk". */
	hold?: ButtonAction;
}
export const BUTTON_DOUBLE_MS = 350;
export const BUTTON_HOLD_MS = 2000;

/** The key name a button is stored under: letters and digits of the DOM `code` (or `key` when a device sends no code). */
export function buttonKeyName(code: string | undefined, key?: string): string {
	return (code || key || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
}

/**
 * Bluetooth push-to-talk buttons (Zello-type) are not keyboards: they report a press as a notification on one of
 * their own GATT characteristics. Such a press gets a key name too: "Ble" + the slot the button is connected in on
 * that device (1–3; three buttons of the same make send the same bytes, the slot tells them apart) + the
 * characteristic's short id (16-bit "FFE1", else the first eight hex digits) + the first bytes as hex, e.g.
 * "Ble1FFE101". The browser (Web Bluetooth) and the Android agent build the same name, so a button learned on a
 * laptop works on a tablet when it sits in the same slot there. Whatever the same characteristic sends next
 * (usually "00") is the release.
 */
export const BLE_KEY_PREFIX = "Ble";
export const BLE_BUTTON_SLOTS = 3;
export function bleKeyName(slot: number, characteristicUuid: string, bytes: ArrayLike<number>): string {
	const u = characteristicUuid.toLowerCase();
	const short = /^0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb$/.test(u) ? u.slice(4, 8) : u.replace(/[^0-9a-f]/g, "").slice(0, 8);
	let hex = "";
	for (let i = 0; i < Math.min(bytes.length, 6); i++) hex += (bytes[i]! & 0xff).toString(16).padStart(2, "0");
	return `${BLE_KEY_PREFIX}${slot}${`${short}${hex}`.toUpperCase()}`;
}
/** A payload of only zero bytes is the button being let go ("01" down, "00" up), never a key of its own. */
export function bleIsRelease(bytes: ArrayLike<number>): boolean {
	if (!bytes.length) return false;
	for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
	return true;
}
/** The slot (1–3) a Bluetooth key belongs to; undefined for a keyboard key. */
export function bleKeySlot(key: string): number | undefined {
	const m = /^Ble([1-3])/.exec(key);
	return m ? Number(m[1]) : undefined;
}

/** What the hub keeps of a station's buttons: known actions, clean key names, a key bound only once, at most three. */
export function stationButtons(v: unknown): StationButton[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out: StationButton[] = [];
	for (const b of v) {
		if (typeof b !== "object" || b === null) continue;
		const { key, action, double, hold } = b as { key?: unknown; action?: unknown; double?: unknown; hold?: unknown };
		const a = BUTTON_ACTIONS.find((x) => x === action);
		if (!a) continue;
		const k = buttonKeyName(typeof key === "string" ? key : "");
		if (k && out.some((o) => o.key === k)) continue;
		// hold-to-talk needs the whole press, so a talk button has nothing else, and nothing else is talk
		const extra = (v: unknown) => (a === "talk" ? undefined : BUTTON_ACTIONS.find((x) => x === v && x !== "talk"));
		const d = extra(double);
		const h = extra(hold);
		out.push({ key: k, action: a, ...(d && { double: d }), ...(h && { hold: h }) });
		if (out.length >= MAX_STATION_BUTTONS) break;
	}
	return out.length ? out : undefined;
}

/**
 * Reads the presses of a station's buttons: one press, two quick presses, held down. A button with only a press
 * action works as before (the action on the way down, "talk" also gets the release). With `double` a single press
 * runs once no second press follows within `BUTTON_DOUBLE_MS`; with `hold` it runs on the release, and keeping the
 * button down for `BUTTON_HOLD_MS` runs `hold` instead. A click-only Bluetooth button (it never says it was let go,
 * so `ble.ts` / the agent release it just before its next press) is recognised by that instant release: from then
 * on each press counts as a whole click and it cannot be held. A button that has once been let go on its own (no
 * press right after) is never taken for one, because Bluetooth batches notifications and a real release can land
 * a millisecond before a quick second press; such a release also ends the click-only reading. Pure apart from
 * the timers it is handed.
 */
export interface PressClock {
	set(fn: () => void, ms: number): unknown;
	clear(timer: unknown): void;
	now(): number;
}
/** A release this close before the next press of the same key is the click-only button's own, not a person letting go. */
const INSTANT_RELEASE_MS = 30;
export function buttonPresses(buttons: StationButton[], run: (action: ButtonAction, down: boolean) => void, clock: PressClock): { press(key: string, down: boolean): boolean; stop(): void } {
	interface KeyState { down: boolean; done: boolean; clickOnly: boolean; /** let go on its own at least once */ released: boolean; settle?: unknown; hold?: unknown; click?: unknown }
	const map = new Map(buttons.filter((b) => b.key).map((b) => [b.key, b] as const));
	const state = new Map<string, KeyState>();
	const press = (key: string, down: boolean): boolean => {
		const b = map.get(key);
		if (!b) return false;
		let s = state.get(key);
		if (!s) state.set(key, (s = { down: false, done: false, clickOnly: false, released: !key.startsWith(BLE_KEY_PREFIX) }));
		const st = s;
		if (!b.double && !b.hold) {
			if (down === st.down) return true; // the key repeats while it is held, or a release without a press
			st.down = down;
			run(b.action, down);
			return true;
		}
		const fire = (a: ButtonAction) => run(a, true);
		const clicked = () => {
			if (!b.double) return fire(b.action);
			st.click = clock.set(() => {
				st.click = undefined;
				fire(b.action);
			}, BUTTON_DOUBLE_MS);
		};
		if (down) {
			if (st.down) return true;
			st.down = true;
			const instant = st.settle !== undefined;
			clock.clear(st.settle);
			st.settle = undefined;
			if (instant && !st.clickOnly && !st.released) {
				// that release was the button's own: the press before it was one click, ended just now
				st.clickOnly = true;
				clock.clear(st.hold);
				st.hold = undefined;
				if (st.click !== undefined) {
					clock.clear(st.click);
					st.click = undefined;
					fire(b.action);
				}
			}
			st.done = false;
			if (st.click !== undefined) {
				clock.clear(st.click);
				st.click = undefined;
				st.done = true;
				fire(b.double!);
			} else if (st.clickOnly) {
				st.done = true;
				clicked();
			} else if (b.hold) {
				st.hold = clock.set(() => {
					st.hold = undefined;
					st.done = true;
					fire(b.hold!);
				}, BUTTON_HOLD_MS);
			}
			return true;
		}
		if (!st.down) return true;
		st.down = false;
		// no press right after: the button was really let go, so it is not a click-only one
		st.settle = clock.set(() => {
			st.settle = undefined;
			st.released = true;
			st.clickOnly = false;
		}, INSTANT_RELEASE_MS);
		clock.clear(st.hold);
		st.hold = undefined;
		if (!st.done) clicked();
		st.done = true;
		return true;
	};
	const stop = () => {
		for (const s of state.values()) {
			clock.clear(s.settle);
			clock.clear(s.hold);
			clock.clear(s.click);
		}
		state.clear();
	};
	return { press, stop };
}

export interface RunView {
	runId: string;
	stationId: string;
	instanceId: string;
	templateId?: string;
	templateName: string;
	state: RunState;
	exchange: ExchangeState;
	currentTaskId?: string;
	/** Set while the next item is held back (exchange "waiting"): what releases it. */
	waiting?: { taskId: string; mode: "ask" | "timer" | "external"; until?: string };
	/** Complete was pressed once: a second press before this time completes the checklist. */
	completeArmedUntil?: string;
	items: RunItem[];
	answered: number;
	total: number;
	voiceTotal: number;
	needsScreen: number;
	skipped: number;
	unsynced: number;
	startedAt: string;
	updatedAt: string;
	users: { sub: string; name?: string }[];
	/** The last thing the hub said (also spoken by the endpoint). */
	lastSpoken?: string;
	/** Live transcript of the current capture window. */
	transcript?: string;
	/** Pending read-back waiting for confirm / no. */
	pendingReadback?: { taskId: string; value: string; valueText: string; transcript: string; confidence: number };
	language: string;
	verbosity: "full" | "short" | "silent";
	/** Set while the hub waits for "start" on a triggered run. */
	pendingReason?: string;
	/** How this station answers right now (station setting, applied live). */
	voiceMode: VoiceMode;
	/** The crew may change `voiceMode` from the run screen (admin allowed it). */
	voiceModeCrew: boolean;
	/** Answers on this station are recorded for training (shown on the run screen). */
	recording?: boolean;
}

export interface ChecklistPick {
	instanceId?: string;
	templateId: string;
	templateName: string;
	refId?: string;
	state: "not_started" | "in_progress" | "ready_to_complete";
	progress?: { done: number; total: number };
	readiness: "full" | "partial" | "none";
	needsScreen: number;
	lastActivity?: string;
	source: "instance" | "template";
	activeRunId?: string;
	/** false when an admin left this template out of the home-screen start buttons (Admin → Start buttons). */
	startable?: boolean;
	/** What the asking station may do with it: start new ones, only work on open ones, or nothing. */
	access?: "start" | "use" | "off";
	/** Language set for this template in Admin → Start buttons (absent → the station's language). */
	language?: string;
}

// ---------------------------------------------------------------- AEP

export interface EndpointCapabilities {
	input?: string[];
	sampleRate?: number;
	aec?: boolean;
	pushToTalk?: boolean;
	wakeWord?: boolean;
	/** The endpoint can speak text itself (browser speechSynthesis / Android TTS). */
	localTts?: boolean;
	/** The endpoint transcribes locally and sends `transcript` frames instead of audio. */
	localStt?: boolean;
}

export type EndpointMessage =
	| { type: "hello"; endpointId: string; stationId: string; capabilities: EndpointCapabilities; language?: string; observer?: boolean }
	| { type: "ptt"; state: "down" | "up" }
	| { type: "audio.end"; reason: "silence" | "ptt" | "timeout" | "cancel" | /** the window closed without any speech in it (the endpoint's own silence detector): nothing to transcribe */ "empty" }
	| { type: "transcript"; text: string; confidence?: number; final?: boolean; /** Other guesses of the recogniser for the same words, best first (browsers give up to five). */ alternatives?: string[] }
	| { type: "spoken"; promptId?: string }
	| { type: "command"; name: string }
	| { type: "takeover" }
	| { type: "ping" };

export type HubToEndpointMessage =
	| { type: "hello"; protocol: number; hubVersion: string; stationId: string; role: "endpoint" | "observer"; runId?: string }
	| { type: "speak"; promptId: string; text: string; language: string; bargeIn: boolean; audioFormat?: "opus" | "wav" | "none" }
	| { type: "listen.open"; promptId: string; maxMs: number; vad: boolean; bias?: string[]; expect?: string; grammar?: string[]; /** Language of the run: the endpoint recognises in it (the checklist decides, not the phone). */ language?: string; /** The station records answers for training: stream the microphone during this window even when recognising on the device. */ record?: boolean }
	| { type: "listen.close" }
	| { type: "status"; state: ExchangeState; text?: string }
	| { type: "released"; by?: string }
	| { type: "run"; run: RunView | null }
	| { type: "event"; event: HubEvent }
	| { type: "navigate"; page: "picker" | "run"; runId?: string; stationId?: string }
	| { type: "pong" }
	| { type: "error"; code: string; message: string };

export const WS_CLOSE_PROTOCOL = 4400;
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_REPLACED = 4409;

// ---------------------------------------------------------------- events

export type HubEventType =
	| "run.started"
	| "run.pending"
	| "run.item.spoken"
	| "run.item.captured"
	| "run.item.readback"
	| "run.item.committed"
	| "run.item.queued_offline"
	| "run.item.skipped"
	| "run.item.escalated"
	| "run.item.missed"
	/** An item changed in Maranics under an open run (the Flow app, or a workflow) and the hub took it over. */
	| "run.item.external"
	| "run.waiting"
	| "run.proceeded"
	| "run.paused"
	| "run.resumed"
	| "run.completed"
	| "run.abandoned"
	| "prompt.queued"
	| "prompt.spoken"
	| "answer.captured"
	| "answer.clarifying"
	| "answer.confirmed"
	| "answer.committed"
	| "answer.queued_offline"
	| "prompt.escalated"
	| "prompt.failed"
	| "station.endpoint"
	| "outbox.changed";

export interface HubEvent {
	type: HubEventType;
	at: string;
	stationId?: string;
	runId?: string;
	promptId?: string;
	taskId?: string;
	text?: string;
	data?: Record<string, unknown>;
}

export function isJoinToken(v: unknown): v is string {
	return typeof v === "string" && v.startsWith(JOIN_TOKEN_PREFIX) && v.length > JOIN_TOKEN_PREFIX.length + 20;
}

/** A station code: six digits, typed instead of scanning the poster (`POST /api/auth/join {code}`). Spaces are allowed on the way in. */
export const JOIN_CODE_LENGTH = 6;
export function normalizeJoinCode(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const digits = v.replace(/[\s-]/g, "");
	return new RegExp(`^\\d{${JOIN_CODE_LENGTH}}$`).test(digits) ? digits : undefined;
}
export function isJoinCode(v: unknown): v is string {
	return normalizeJoinCode(v) !== undefined;
}

export function isDeviceToken(v: unknown): v is string {
	return typeof v === "string" && v.startsWith(DEVICE_TOKEN_PREFIX) && v.length > DEVICE_TOKEN_PREFIX.length + 20;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseEndpointMessage(raw: string): EndpointMessage | undefined {
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isObj(v) || typeof v.type !== "string") return undefined;
	switch (v.type) {
		case "hello":
			return typeof v.endpointId === "string" && typeof v.stationId === "string"
				? { type: "hello", endpointId: v.endpointId, stationId: v.stationId, capabilities: isObj(v.capabilities) ? (v.capabilities as EndpointCapabilities) : {}, language: typeof v.language === "string" ? v.language : undefined, observer: v.observer === true }
				: undefined;
		case "ptt":
			return v.state === "down" || v.state === "up" ? { type: "ptt", state: v.state } : undefined;
		case "audio.end":
			return { type: "audio.end", reason: (["silence", "ptt", "timeout", "cancel", "empty"] as const).find((r) => r === v.reason) ?? "silence" };
		case "transcript":
			return typeof v.text === "string" ? { type: "transcript", text: v.text, confidence: typeof v.confidence === "number" ? v.confidence : undefined, final: v.final !== false, alternatives: Array.isArray(v.alternatives) ? v.alternatives.filter((a): a is string => typeof a === "string" && a.length <= 300).slice(0, 5) : undefined } : undefined;
		case "spoken":
			return { type: "spoken", promptId: typeof v.promptId === "string" ? v.promptId : undefined };
		case "command":
			return typeof v.name === "string" ? { type: "command", name: v.name } : undefined;
		case "takeover":
			return { type: "takeover" };
		case "ping":
			return { type: "ping" };
		default:
			return undefined;
	}
}
