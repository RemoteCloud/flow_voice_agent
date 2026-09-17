/** HTTP view types shared with the web app (relative import from web/src). */
import type { AuthErrorCode, AuthProviderView } from "./http/auth.js";
import type { ChecklistPick, RunView } from "./protocol.js";
import type { AuditEntry, Device, LibraryTemplate, EventMapping, OutboxEntry, PendingEnrollment, Station, StationJoin, VoiceProfile } from "./store/HubStore.js";

export type { LibraryTemplate };
/** `GET /api/library`: the central checklist register with its language and trigger words. */
export interface LibraryView {
	templates: (LibraryTemplate & { language?: string; words: Record<string, string[]> })[];
}
/** `GET /api/library/available`: what the Templates app offers, flagged when already in the register. */
export interface LibraryAvailable {
	templates: { templateId: string; name: string; refId?: string; categoryName?: string; registered: boolean }[];
}
export type { AuthErrorCode, AuthProviderView, ChecklistPick, RunView, Station, StationJoin, Device, PendingEnrollment, VoiceProfile, EventMapping, OutboxEntry, AuditEntry };

export interface MeResponse {
	sub: string;
	name?: string;
	email?: string;
	positionName?: string;
	/** Maranics location of the sign-in (name, or id when the claim has no name). Flows start there. */
	locationName?: string;
	isAdmin: boolean;
	stationId?: string;
	/** How the station was bound: scanned QR ("join") or picked on screen ("pick"). */
	stationSource?: "join" | "pick";
	sessionId: string;
	credential: "ok" | "none" | "expired" | "refresh_failed";
}

export interface SessionProbeResponse {
	authenticated: boolean;
	me?: MeResponse;
	provider: AuthProviderView;
	hubVersion: string;
	vesselId: string;
	/** The address the Android app pairs with (also rendered at GET /api/qr.svg). */
	hubUrl: string;
	stations: Station[];
	speech: { stt: "endpoint" | "http"; tts: "endpoint" | "http"; /** the hub can transcribe a window the device could not (POST /api/stt) */ sttBackup?: boolean };
	maranicsConfigured: boolean;
}

export interface HealthResponse {
	ok: boolean;
	hubVersion: string;
	uptimeSec: number;
	stt: "endpoint" | "http";
	sttHealthy?: boolean;
	outboxQueued: number;
	outboxFailed: number;
	activeRuns: number;
	endpoints: number;
	maranicsConfigured: boolean;
}

export interface StationView extends Station {
	endpoint?: { endpointId: string; user?: string; observers: number; aec?: boolean; pushToTalk?: boolean; localStt?: boolean; localTts?: boolean };
	activeRun?: { runId: string; templateName: string; state: string; answered: number; total: number };
	/** The station's live QR join token, never the hash. */
	join?: { tokenHint: string; createdAt: string; createdBy?: string; /** `/client#/join/<token>` — admins only; absent on links minted before the hub kept them (rotate once). */ path?: string };
}

/** `POST /api/auth/join` — redeem a station QR token (no session required). */
export interface JoinRequest {
	token: string;
}
export interface JoinResponse {
	ok: true;
	station: { stationId: string; name: string; location?: string };
	/** true = the caller already had a session and it is now bound; false = a join cookie was set, sign in next. */
	authenticated: boolean;
	me?: MeResponse;
}
/** `POST /api/stations/:id/join-token` — the token is shown once; the hub stores only its hash. */
export interface JoinTokenResponse {
	stationId: string;
	token: string;
	tokenHint: string;
	createdAt: string;
	/** `/client#/join/<token>` — the client may prepend a different base URL before printing. */
	path: string;
	/** `path` on HUB_PUBLIC_URL, or on the request origin when unset. */
	url: string;
}

export interface StatusResponse {
	hubVersion: string;
	uptimeSec: number;
	stations: StationView[];
	runs: RunView[];
	outbox: { queued: number; failed: number; entries: OutboxEntry[] };
	devices: Device[];
	pendingEnrollments: PendingEnrollment[];
	sessions: { id: string; sub: string; name?: string; stationId?: string; lastSeenAt: string; createdAt: string; credential: string }[];
	prompts: { promptId: string; stationId: string; prompt: string; state: string; createdAt: string }[];
	speech: { stt: "endpoint" | "http"; tts: "endpoint" | "http"; sttUrl?: string; sttBackup?: boolean; sttBackupUrl?: string };
	settings: { readNotices: boolean; tzMode: "utc" | "local"; confirmation: "required" | "optional"; /** Template ids that get a start button on the phone/tablet home screen and in the voice menu; empty or absent → every template. */ startable?: string[]; /** Template id → language the checklist is written in (en/sv/no/fr/de); wins over the station language. */ templateLanguages?: Record<string, string>; /** Template id → item key (`answerKey`) → words that count as that item's answer ("up", "closed"). */ itemAnswers?: Record<string, Record<string, string[]>> };
}

export interface EnrollRequest {
	deviceName: string;
	kind: Device["kind"];
}
export interface EnrollResponse {
	code: string;
	pollAfterSec: number;
}
export interface EnrollPollResponse {
	state: "pending" | "approved" | "unknown";
	token?: string;
	deviceId?: string;
}

export interface LogoutResponse {
	endSessionUrl: string;
}

export interface ApiError {
	error: string;
	code: string;
}
