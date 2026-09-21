/** Flow Voice configuration from environment variables. Pure (no process access); smoke-tested. */
import path from "node:path";
import { normalizeBaseUrl } from "./core/http.js";

export type LogLevel = "debug" | "info" | "warn";

export interface OidcEnv {
	issuer: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	scopes: string;
	prompt?: string;
	audience: string;
	postLogoutRedirectUri?: string;
	clockSkewSec: number;
	httpTimeoutMs: number;
	flowMaxAgeSec: number;
}

export interface MaranicsEnv {
	host: string;
	flowsBaseUrl: string;
	templatesBaseUrl: string;
	tenant: string;
	umApiBaseUrl: string;
	/** Hostname suffixes the hub may call with a user's token. */
	allowedHosts: string[];
}

export interface SpeechEnv {
	/** `endpoint` = the device transcribes (browser / Android); `http` = POST audio to `sttUrl` (OpenAI-compatible /v1/audio/transcriptions). */
	sttMode: "endpoint" | "http";
	sttUrl?: string;
	sttModel: string;
	sttApiKey?: string;
	/** Backup recogniser: the device still transcribes itself, and sends the audio of a window here only when it could not (no model / language pack, nothing recognised). Same API as `sttUrl`. */
	sttBackupUrl?: string;
	sttBackupModel: string;
	/** `endpoint` = device speaks; `http` = GET `ttsUrl?text=` for audio (Piper HTTP server). */
	ttsMode: "endpoint" | "http";
	ttsUrl?: string;
	/** Raw `TTS_VOICES` (language=piper voice, comma-separated); defaults in `speech/tts.ts`. */
	ttsVoices?: string;
}

export interface PolicyEnv {
	listenMs: number;
	confirmMs: number;
	exchangeMs: number;
	retries: number;
	/** Relative times further in the past than this are rejected (hours). */
	maxPastHours: number;
	tzMode: "utc" | "local";
	timeZone?: string;
	defaultLanguage: string;
	readNotices: boolean;
}

export interface HubEnv {
	host: string;
	port: number;
	dataDir: string;
	publicDir: string;
	publicUrl?: string;
	trustProxy: boolean;
	secret: string;
	sessionSecret: string;
	vesselId: string;
	logLevel: LogLevel;
	maranics?: MaranicsEnv;
	oidc?: OidcEnv;
	oidcReason?: string;
	/** Password of the central admin area (`/central`, tenant management). Unset → main-hub admins manage tenants instead. */
	centralPassword?: string;
	/** Set on the core of a token tenant (`server/tenants.ts`); the main hub leaves it unset. */
	tokenTenant?: { id: string; name: string };
	speech: SpeechEnv;
	policy: PolicyEnv;
	/** Service bearer tokens accepted on POST /v1/prompts and /v1/runs/trigger (comma separated). */
	serviceTokens: string[];
	/** HMAC secrets per webhook source (`*` = any source). */
	webhookSecrets: Record<string, string>;
	mqttUrl?: string;
	mqttUsername?: string;
	mqttPassword?: string;
	/** Dev only: a "Sign in as …" button that needs no identity provider. */
	devUser?: { sub: string; name: string; email: string };
	/** Dev only: static bearer used against Maranics when signed in as the dev user. */
	devToken?: string;
}

export type Env = Record<string, string | undefined>;

const s = (e: Env, ...keys: string[]): string | undefined => {
	for (const k of keys) {
		const v = e[k]?.trim();
		if (v) return v;
	}
	return undefined;
};
const n = (e: Env, key: string, fallback: number): number => {
	const v = Number(e[key]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
};
const b = (e: Env, key: string, fallback = false): boolean => {
	const v = e[key]?.trim().toLowerCase();
	if (v === undefined || v === "") return fallback;
	return v === "1" || v === "true" || v === "yes";
};

export class EnvError extends Error {}

export function parseEnv(e: Env, defaults: { cwd: string } = { cwd: process.cwd() }): HubEnv {
	const secret = s(e, "HUB_SECRET", "FLOW_VOICE_SECRET");
	const sessionSecret = s(e, "SESSION_SECRET") ?? secret;
	if (!secret || !sessionSecret) throw new EnvError("HUB_SECRET (and optionally SESSION_SECRET) must be set — generate one with: openssl rand -base64 32");
	if (secret.length < 16 || sessionSecret.length < 16) throw new EnvError("HUB_SECRET / SESSION_SECRET must be at least 16 characters");
	const dataDir = path.resolve(defaults.cwd, s(e, "HUB_DATA_DIR", "DATA_DIR") ?? "data");
	const publicDir = path.resolve(defaults.cwd, s(e, "HUB_PUBLIC_DIR", "PUBLIC_DIR") ?? "public");

	const tenant = s(e, "HUB_TENANT", "MARANICS_TENANT");
	const host = normalizeBaseUrl(s(e, "HUB_MARANICS_HOST", "FLOW_API_URL", "MARANICS_HOST"));
	const issuerRaw = normalizeBaseUrl(s(e, "HUB_OIDC_ISSUER", "OIDC_ISSUER")) ?? (normalizeBaseUrl(s(e, "HUB_OIDC_BASE_URL")) && tenant ? `${normalizeBaseUrl(s(e, "HUB_OIDC_BASE_URL"))}/${encodeURIComponent(tenant)}` : undefined);
	let maranics: MaranicsEnv | undefined;
	if (tenant && host) {
		let umDefault = `${host}/app/usermanagement`;
		if (issuerRaw) {
			try {
				umDefault = `${new URL(issuerRaw).origin}/external/api`;
			} catch {
				/* keep the gateway layout */
			}
		}
		maranics = {
			host,
			tenant,
			flowsBaseUrl: normalizeBaseUrl(s(e, "HUB_FLOWS_BASE_URL", "FLOWS_BASE_URL")) ?? `${host}/app/flows`,
			templatesBaseUrl: normalizeBaseUrl(s(e, "HUB_TEMPLATES_BASE_URL", "TEMPLATES_BASE_URL")) ?? `${host}/app/templates`,
			umApiBaseUrl: normalizeBaseUrl(s(e, "HUB_UM_API_BASE_URL", "UM_API_BASE_URL")) ?? umDefault,
			allowedHosts: (s(e, "HUB_ALLOWED_HOSTS") ?? ".fringeflow.com,.maranics-staging.com,.maranics.com,localhost,127.0.0.1")
				.split(",")
				.map((x) => x.trim().toLowerCase())
				.filter(Boolean),
		};
	}

	let oidc: OidcEnv | undefined;
	let oidcReason: string | undefined;
	const clientId = s(e, "HUB_OIDC_CLIENT_ID", "OIDC_CLIENT_ID");
	const clientSecret = s(e, "HUB_OIDC_CLIENT_SECRET", "OIDC_CLIENT_SECRET");
	const publicUrl = normalizeBaseUrl(s(e, "HUB_PUBLIC_URL", "PUBLIC_URL"));
	if (issuerRaw && clientId && clientSecret) {
		const redirectUri = s(e, "HUB_OIDC_REDIRECT_URI", "OIDC_REDIRECT_URI") ?? (publicUrl ? `${publicUrl}/api/auth/callback` : undefined);
		if (!redirectUri) oidcReason = "HUB_OIDC_REDIRECT_URI or HUB_PUBLIC_URL must be set for OIDC sign-in";
		else
			oidc = {
				issuer: issuerRaw,
				clientId,
				clientSecret,
				redirectUri,
				scopes: s(e, "HUB_OIDC_SCOPES") ?? "openid email profile offline_access",
				prompt: s(e, "HUB_OIDC_PROMPT"),
				audience: s(e, "HUB_OIDC_AUDIENCE") ?? clientId,
				postLogoutRedirectUri: s(e, "HUB_OIDC_POST_LOGOUT_REDIRECT_URI"),
				clockSkewSec: n(e, "HUB_OIDC_CLOCK_SKEW_SEC", 120),
				httpTimeoutMs: n(e, "HUB_OIDC_HTTP_TIMEOUT_MS", 8000),
				flowMaxAgeSec: n(e, "HUB_OIDC_FLOW_MAX_AGE_SEC", 600),
			};
	} else oidcReason = "Sign-in is not configured (HUB_OIDC_ISSUER, HUB_OIDC_CLIENT_ID, HUB_OIDC_CLIENT_SECRET)";

	const centralPassword = s(e, "CENTRAL_PASSWORD", "HUB_CENTRAL_PASSWORD");
	if (centralPassword && centralPassword.length < 12) throw new EnvError("CENTRAL_PASSWORD must be at least 12 characters");
	const devUserName = s(e, "DEV_USER");
	const devUser = devUserName ? { sub: `dev:${devUserName.toLowerCase().replace(/\s+/g, "-")}`, name: devUserName, email: s(e, "DEV_USER_EMAIL") ?? `${devUserName.toLowerCase().replace(/\s+/g, ".")}@example.com` } : undefined;

	const sttUrl = normalizeBaseUrl(s(e, "STT_ENDPOINT", "STT_URL"));
	const ttsUrl = normalizeBaseUrl(s(e, "TTS_ENDPOINT", "TTS_URL"));
	const webhookSecrets: Record<string, string> = {};
	for (const pair of (s(e, "WEBHOOK_SECRETS") ?? "").split(",")) {
		const [k, ...rest] = pair.split("=");
		if (k?.trim() && rest.length) webhookSecrets[k.trim()] = rest.join("=").trim();
	}
	const single = s(e, "WEBHOOK_SECRET");
	if (single) webhookSecrets["*"] = single;
	const levelRaw = (s(e, "LOG_LEVEL") ?? "info").toLowerCase();
	const logLevel: LogLevel = levelRaw === "debug" || levelRaw === "warn" ? levelRaw : "info";

	return {
		host: s(e, "HUB_HOST", "HOST") ?? "0.0.0.0",
		port: n(e, "HUB_PORT", n(e, "PORT", 8443)),
		dataDir,
		publicDir,
		publicUrl,
		trustProxy: b(e, "HUB_TRUST_PROXY"),
		secret,
		sessionSecret,
		vesselId: s(e, "VESSEL_ID") ?? "vessel",
		logLevel,
		maranics,
		oidc,
		oidcReason,
		speech: {
			sttMode: sttUrl ? "http" : "endpoint",
			sttUrl,
			sttModel: s(e, "STT_MODEL") ?? "whisper-1",
			sttApiKey: s(e, "STT_API_KEY"),
			sttBackupUrl: normalizeBaseUrl(s(e, "STT_BACKUP_ENDPOINT", "STT_BACKUP_URL")),
			sttBackupModel: s(e, "STT_BACKUP_MODEL") ?? s(e, "STT_MODEL") ?? "whisper-1",
			ttsMode: ttsUrl ? "http" : "endpoint",
			ttsUrl,
			ttsVoices: s(e, "TTS_VOICES"),
		},
		policy: {
			listenMs: n(e, "LISTEN_MS", 8000),
			confirmMs: n(e, "CONFIRM_MS", 10000),
			exchangeMs: n(e, "EXCHANGE_MS", 60000),
			retries: n(e, "RETRIES", 2),
			maxPastHours: n(e, "MAX_PAST_HOURS", 12),
			tzMode: (s(e, "TZ_MODE") ?? "utc").toLowerCase() === "local" ? "local" : "utc",
			timeZone: s(e, "TZ"),
			defaultLanguage: s(e, "DEFAULT_LANGUAGE") ?? "en",
			readNotices: b(e, "READ_NOTICES"),
		},
		centralPassword,
		serviceTokens: (s(e, "SERVICE_TOKENS", "FLOW_SERVICE_TOKEN") ?? "")
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean),
		webhookSecrets,
		mqttUrl: s(e, "MQTT_URL"),
		mqttUsername: s(e, "MQTT_USERNAME"),
		mqttPassword: s(e, "MQTT_PASSWORD"),
		devUser,
		devToken: s(e, "DEV_MARANICS_TOKEN"),
	};
}
