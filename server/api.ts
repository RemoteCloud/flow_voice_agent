/** HTTP view types shared with the web app (relative import from web/src). */
import type { AuthErrorCode, AuthProviderView } from "./http/auth.js";
import type { ChecklistPick, RunView } from "./protocol.js";
import type { AuditEntry, Device, EventMapping, OutboxEntry, PendingEnrollment, Station, VoiceProfile } from "./store/HubStore.js";

export type { AuthErrorCode, AuthProviderView, ChecklistPick, RunView, Station, Device, PendingEnrollment, VoiceProfile, EventMapping, OutboxEntry, AuditEntry };

export interface MeResponse {
	sub: string;
	name?: string;
	email?: string;
	positionName?: string;
	isAdmin: boolean;
	stationId?: string;
	sessionId: string;
	credential: "ok" | "none" | "expired" | "refresh_failed";
}

export interface SessionProbeResponse {
	authenticated: boolean;
	me?: MeResponse;
	provider: AuthProviderView;
	hubVersion: string;
	vesselId: string;
	stations: Station[];
	speech: { stt: "endpoint" | "http"; tts: "endpoint" | "http" };
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
	speech: { stt: "endpoint" | "http"; tts: "endpoint" | "http"; sttUrl?: string };
	settings: { readNotices: boolean; tzMode: "utc" | "local"; confirmation: "required" | "optional" };
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
