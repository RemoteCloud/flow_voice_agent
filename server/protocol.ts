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
export type ExchangeState = "idle" | "speaking" | "listening" | "interpreting" | "confirming" | "committing" | "clarifying" | "escalated";

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
	| { type: "audio.end"; reason: "silence" | "ptt" | "timeout" | "cancel" }
	| { type: "transcript"; text: string; confidence?: number; final?: boolean }
	| { type: "spoken"; promptId?: string }
	| { type: "command"; name: string }
	| { type: "takeover" }
	| { type: "ping" };

export type HubToEndpointMessage =
	| { type: "hello"; protocol: number; hubVersion: string; stationId: string; role: "endpoint" | "observer"; runId?: string }
	| { type: "speak"; promptId: string; text: string; language: string; bargeIn: boolean; audioFormat?: "opus" | "wav" | "none" }
	| { type: "listen.open"; promptId: string; maxMs: number; vad: boolean; bias?: string[]; expect?: string; grammar?: string[] }
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
			return { type: "audio.end", reason: (["silence", "ptt", "timeout", "cancel"] as const).find((r) => r === v.reason) ?? "silence" };
		case "transcript":
			return typeof v.text === "string" ? { type: "transcript", text: v.text, confidence: typeof v.confidence === "number" ? v.confidence : undefined, final: v.final !== false } : undefined;
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
