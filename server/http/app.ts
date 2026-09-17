/**
 * HTTP surface (Hono): the browser API under /api/*, the integration API under /v1/*, ops
 * endpoints, and the static PWA — all on one port, one origin (spec 10, 5.5, 21.4).
 */
import { readFileSync, existsSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import QRCode from "qrcode";
import { getCookie } from "hono/cookie";
import type { ApiError, EnrollPollResponse, EnrollRequest, EnrollResponse, HealthResponse, JoinRequest, JoinResponse, JoinTokenResponse, LibraryView, LogoutResponse, MeResponse, SessionProbeResponse, StationView, StatusResponse } from "../api.js";
import { isJoinToken } from "../protocol.js";
import type { HubEnv } from "../env.js";
import type { Logger } from "../core/log.js";
import type { SttAdapter } from "../speech/stt.js";
import { MAX_TTS_CHARS, type HttpTts } from "../speech/tts.js";
import { hashDeckToken, newDeckId, newDeckToken, newJoinToken, tokenHint, verifyDeckToken } from "../store/crypto.js";
import type { Credentials } from "../store/credentials.js";
import type { Device, HubData, HubSession, HubStore, PendingEnrollment, PromptRecord, Station, StationJoin, StationTemplateRule, VoiceProfile, EventMapping } from "../store/HubStore.js";
import { deriveKey, openToken, sealToken } from "../store/crypto.js";
import { EngineError, type RunEngine } from "../voice/RunEngine.js";
import { SpeechModels, VOSK_MODELS } from "../speech/models.js";
import type { Outbox } from "../voice/Outbox.js";
import type { Gateway } from "../ws/Gateway.js";
import { OidcAuth } from "./auth.js";
import { JOIN_LIMITS, LOGIN_LIMITS, RateLimiter } from "./rateLimit.js";
import { ROLE_HEADER, clearJoinCookie, clearLoginCookie, clearSession, JOIN_MAX_AGE_SEC, LOGIN_COOKIE, newSession, readJoinCookie, readLoginCookie, readSession, requireSession, sidHash, validSession, writeJoinCookie, writeLoginCookie, writeSession, type SessionEnv } from "./session.js";
import { resolveStatic } from "./static.js";

export interface AppDeps {
	env: HubEnv;
	store: HubStore;
	auth: OidcAuth;
	credentials: Credentials;
	engine: RunEngine;
	outbox: Outbox;
	gateway: Gateway;
	stt: SttAdapter;
	/** Backup recogniser for windows the device could not transcribe (STT_BACKUP_ENDPOINT); absent → POST /api/stt answers 404. */
	sttBackup?: SttAdapter;
	tts?: HttpTts;
	log: Logger;
	version: string;
	now(): number;
	uptime(): number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function clientIp(c: Context, trustProxy: boolean): string {
	if (trustProxy) {
		const xff = c.req.header("x-forwarded-for");
		if (xff) return xff.split(",")[0].trim();
	}
	return c.req.header("x-real-ip") ?? "unknown";
}

function hmacOk(secret: string, raw: string, header: string | undefined): boolean {
	if (!header) return false;
	const given = header.replace(/^sha256=/i, "").trim();
	const expected = createHmac("sha256", secret).update(raw).digest("hex");
	if (given.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
}

/** Station → per-template rules: only known access values and languages survive; an empty rule is dropped. */
function templateRules(raw: unknown): Record<string, StationTemplateRule> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, StationTemplateRule> = {};
	for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!id.trim() || !v || typeof v !== "object") continue;
		const r = v as { access?: unknown; language?: unknown };
		const rule: StationTemplateRule = {};
		if (r.access === "start" || r.access === "use" || r.access === "off") rule.access = r.access;
		if (typeof r.language === "string" && /^(en|sv|no|fr|de)$/.test(r.language)) rule.language = r.language;
		if (rule.access || rule.language) out[id] = rule;
	}
	return Object.keys(out).length ? out : undefined;
}

export function createApp(deps: AppDeps): Hono {
	const { env, store, auth, engine, log } = deps;
	const secure = !!env.publicUrl && env.publicUrl.startsWith("https://");
	const loginLimiter = new RateLimiter(LOGIN_LIMITS, deps.now);
	const joinLimiter = new RateLimiter(JOIN_LIMITS, deps.now);
	const app = new Hono();

	const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502, code: string, error: string) => c.json<ApiError>({ error, code }, status);
	const handle = async (c: Context, fn: () => Promise<Response>): Promise<Response> => {
		try {
			return await fn();
		} catch (err) {
			if (err instanceof EngineError) {
				// refusals are part of normal use, but they must be findable when someone says "it would not start"
				log.warn(`${c.req.method} ${c.req.path} refused: ${err.status} ${err.code}: ${err.message}`);
				return fail(c, err.status as 400, err.code, err.message);
			}
			log.error(`${c.req.method} ${c.req.path}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
			return fail(c, 500, "INTERNAL", err instanceof Error ? err.message : String(err));
		}
	};

	const sessionDeps = {
		secret: env.sessionSecret,
		secure,
		epoch: () => store.get().sessionEpoch,
		now: deps.now,
		lookup: (h: string) => store.get().sessions.find((s) => s.sidHash === h),
		touch: (row: HubSession, nowMs: number) => {
			if (nowMs - Date.parse(row.lastSeenAt) > 60_000) {
				row.lastSeenAt = new Date(nowMs).toISOString();
				void store.update(() => {});
			}
		},
	};

	const meOf = (row: HubSession): MeResponse => {
		const u = store.get().users.find((x) => x.sub === row.sub);
		return { sub: row.sub, name: u?.name, email: u?.email, positionName: u?.positionName, locationName: u?.locationName ?? u?.locationId, isAdmin: u?.isAdmin ?? false, stationId: row.stationId, stationSource: row.stationSource, sessionId: row.id, credential: row.credential ? row.credential.state : row.sub.startsWith("dev:") ? "ok" : "none" };
	};

	/** Bind a session to a station (store row + the live row object). */
	const bindStation = async (row: HubSession, stationId: string, source: "join" | "pick"): Promise<void> => {
		await store.update((d) => {
			const s = d.sessions.find((x) => x.id === row.id);
			if (s) {
				s.stationId = stationId;
				s.stationSource = source;
			}
		});
		row.stationId = stationId;
		row.stationSource = source;
	};

	/** After any successful sign-in: consume the `fv_join` cookie when it is fresh and its station still exists. */
	const applyJoinCookie = async (c: Context, row: HubSession): Promise<void> => {
		const j = await readJoinCookie(c, env.sessionSecret);
		if (j && deps.now() - j.iat <= JOIN_MAX_AGE_SEC * 1000 && store.get().stations.some((s) => s.stationId === j.stationId)) {
			await bindStation(row, j.stationId, "join");
			log.info(`session ${row.id} joined station ${j.stationId} via QR`);
		}
		if (j) clearJoinCookie(c, secure);
	};

	const findJoin = (token: string): StationJoin | undefined => Object.values(store.get().stationJoins).find((j) => verifyDeckToken(token, j.tokenHash));

	/** Session from cookie or a device token; used by both the HTTP API and the WebSocket upgrade. */
	const sessionFromRequest = async (c: Context): Promise<HubSession | undefined> => {
		const claims = await readSession(c, env.sessionSecret);
		if (claims && validSession(claims, deps.now(), store.get().sessionEpoch)) {
			const row = store.get().sessions.find((s) => s.sidHash === sidHash(claims.sid));
			if (row && row.sub === claims.sub) return row;
		}
		return undefined;
	};

	const deviceFromRequest = (c: Context): Device | undefined => {
		const h = c.req.header("authorization") ?? "";
		const m = /^Bearer\s+(\S+)$/i.exec(h);
		const token = m?.[1] ?? c.req.header("x-device-token") ?? getCookie(c, "fv_device");
		if (!token) return undefined;
		return store.get().devices.find((d) => !d.revoked && verifyDeckToken(token, d.tokenHash));
	};

	const serviceAuthorized = (c: Context): boolean => {
		const h = c.req.header("authorization") ?? "";
		const m = /^Bearer\s+(\S+)$/i.exec(h);
		return !!m && env.serviceTokens.includes(m[1]);
	};

	// ============================================================ /api (browser + app)
	const api = new Hono<SessionEnv>();

	api.get("/health", async (c) => {
		const d = store.get();
		const res: HealthResponse = {
			ok: true,
			hubVersion: deps.version,
			uptimeSec: Math.round(deps.uptime()),
			stt: deps.stt.kind,
			sttHealthy: deps.stt.kind === "http" ? await deps.stt.healthy() : undefined,
			outboxQueued: d.outbox.filter((o) => o.state === "queued").length,
			outboxFailed: d.outbox.filter((o) => o.state === "failed").length,
			activeRuns: d.runs.filter((r) => r.state === "active" || r.state === "paused" || r.state === "pending").length,
			endpoints: deps.gateway.stations().length,
			maranicsConfigured: !!env.maranics,
		};
		return c.json(res);
	});

	// ----- pairing: the hub's own address as a QR code, scanned by the Android app on first launch
	/** HUB_PUBLIC_URL, or the origin this request arrived on (behind a proxy: X-Forwarded-Proto/Host when HUB_TRUST_PROXY). */
	const hubUrlOf = (c: Context): string => {
		if (env.publicUrl) return env.publicUrl;
		const u = new URL(c.req.url);
		const proto = (env.trustProxy && c.req.header("x-forwarded-proto")?.split(",")[0].trim()) || u.protocol.replace(":", "");
		const host = (env.trustProxy && c.req.header("x-forwarded-host")?.split(",")[0].trim()) || c.req.header("host") || u.host;
		return `${proto}://${host}`;
	};
	api.get("/qr.svg", async (c) => {
		const svg = await QRCode.toString(hubUrlOf(c), { type: "svg", errorCorrectionLevel: "M", margin: 1 });
		c.header("Content-Type", "image/svg+xml; charset=utf-8");
		c.header("Cache-Control", "no-cache");
		return c.body(svg);
	});

	// ----- auth
	api.get("/auth/session", async (c) => {
		const row = await sessionFromRequest(c);
		const res: SessionProbeResponse = { authenticated: !!row, me: row ? meOf(row) : undefined, provider: auth.providerView(), hubVersion: deps.version, vesselId: env.vesselId, hubUrl: hubUrlOf(c), stations: store.get().stations, speech: { stt: env.speech.sttMode, tts: env.speech.ttsMode, sttBackup: !!deps.sttBackup }, maranicsConfigured: !!env.maranics };
		return c.json(res);
	});

	api.get("/auth/login", async (c) => {
		const ip = clientIp(c, env.trustProxy);
		const lim = loginLimiter.check(ip);
		if (!lim.ok) return c.redirect(`/?auth_error=rate_limited`);
		const returnTo = str(c.req.query("returnTo"));
		const start = await auth.startLogin(returnTo);
		if (!start.ok) return c.redirect(`/?auth_error=${start.code}`);
		await writeLoginCookie(c, start.cookie, env.sessionSecret, secure, env.oidc?.flowMaxAgeSec ?? 600);
		return c.redirect(start.redirectUrl);
	});

	api.get("/auth/callback", async (c) => {
		const ip = clientIp(c, env.trustProxy);
		const cookie = await readLoginCookie(c, env.sessionSecret);
		clearLoginCookie(c, secure);
		const out = await auth.completeLogin(Object.fromEntries(new URL(c.req.url).searchParams), cookie, ip);
		const target = (ok: boolean, code?: string) => {
			const base = out.returnTo && /^(flowvoice:\/\/|\/)/.test(out.returnTo) ? out.returnTo : "/";
			if (ok) return base;
			const u = base.includes("?") ? `${base}&` : `${base}?`;
			return `${u}auth_error=${code ?? "unknown"}`;
		};
		if (!out.ok) return c.redirect(target(false, out.code));
		await writeSession(c, newSession({ sid: out.sid, sub: out.user.sub, tenant: env.maranics?.tenant ?? "", epoch: store.get().sessionEpoch, nowMs: deps.now() }), env.sessionSecret, secure);
		await applyJoinCookie(c, out.session);
		return c.redirect(target(true));
	});

	api.post("/auth/dev", async (c) => {
		if (!env.devUser) return fail(c, 404, "NOT_FOUND", "dev sign-in is not enabled");
		// inside a token tenant the dispatcher says how the caller got in (main-hub admin, or a station link)
		const role = env.tokenTenant ? (c.req.header(ROLE_HEADER) === "admin" ? "admin" : "client") : undefined;
		const out = await auth.devLogin(clientIp(c, env.trustProxy), role);
		if (!out.ok) return fail(c, 500, out.code, out.detail);
		await writeSession(c, newSession({ sid: out.sid, sub: out.user.sub, tenant: env.maranics?.tenant ?? "", epoch: store.get().sessionEpoch, nowMs: deps.now() }), env.sessionSecret, secure);
		await applyJoinCookie(c, out.session);
		return c.json(meOf(out.session));
	});

	// ----- station QR join (no session required; the token is only ever in the JSON body, never in a URL the hub sees)
	api.post("/auth/join", async (c) => {
		const ip = clientIp(c, env.trustProxy);
		const lim = joinLimiter.check(ip);
		if (!lim.ok) {
			c.header("Retry-After", String(lim.retryAfterSec));
			return fail(c, 429, "RATE_LIMITED", "too many attempts");
		}
		const body = (await c.req.json().catch(() => ({}))) as Partial<JoinRequest>;
		const token = str(body.token);
		if (!isJoinToken(token)) return fail(c, 400, "BAD_REQUEST", "token is required");
		const join = findJoin(token);
		const station = join && store.get().stations.find((s) => s.stationId === join.stationId);
		if (!join || !station) return fail(c, 404, "JOIN_INVALID", "this QR code is no longer valid");
		const view = { stationId: station.stationId, name: station.name, location: station.location };
		const row = await sessionFromRequest(c);
		if (row) {
			await bindStation(row, station.stationId, "join");
			log.info(`session ${row.id} joined station ${station.stationId} via QR`);
			return c.json<JoinResponse>({ ok: true, station: view, authenticated: true, me: meOf(row) });
		}
		await writeJoinCookie(c, { stationId: station.stationId, iat: deps.now() }, env.sessionSecret, secure);
		log.info(`station ${station.stationId} QR scanned from ${ip}; awaiting sign-in`);
		return c.json<JoinResponse>({ ok: true, station: view, authenticated: false });
	});

	api.post("/auth/logout", async (c) => {
		const row = await sessionFromRequest(c);
		const hint = row ? deps.credentials.idToken(row) : undefined;
		const res = await auth.logout(row, hint);
		if (row) deps.gateway.dropSession(row.id);
		clearSession(c, secure);
		return c.json<LogoutResponse>(res);
	});

	// ----- device enrollment (no session)
	api.post("/devices/enroll", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Partial<EnrollRequest>;
		const deviceName = str(body.deviceName) ?? "device";
		const kind = (["pwa", "android", "pi", "other"] as const).find((k) => k === body.kind) ?? "other";
		const code = String(Math.floor(100000 + Math.random() * 900000));
		const pending: PendingEnrollment = { code, deviceName, kind, requestedAt: new Date(deps.now()).toISOString() };
		await store.update((d) => {
			d.pendingEnrollments = d.pendingEnrollments.filter((p) => Date.parse(p.requestedAt) > deps.now() - 30 * 60_000);
			d.pendingEnrollments.push(pending);
		});
		log.info(`enrollment requested by "${deviceName}" (${kind}): code ${code}`);
		return c.json<EnrollResponse>({ code, pollAfterSec: 3 });
	});

	api.get("/devices/enroll/:code", async (c) => {
		const p = store.get().pendingEnrollments.find((x) => x.code === c.req.param("code"));
		if (!p) return c.json<EnrollPollResponse>({ state: "unknown" });
		if (!p.token) return c.json<EnrollPollResponse>({ state: "pending" });
		const token = p.token;
		await store.update((d) => {
			d.pendingEnrollments = d.pendingEnrollments.filter((x) => x.code !== p.code);
		});
		c.header("Set-Cookie", `fv_device=${token}; Path=/; Max-Age=${3 * 365 * 86400}; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`);
		return c.json<EnrollPollResponse>({ state: "approved", token, deviceId: p.deviceId });
	});

	// everything below needs a signed-in user
	api.use("*", requireSession(sessionDeps));

	api.get("/auth/me", (c) => c.json(meOf(c.get("sessionRow"))));

	api.put("/auth/station", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { stationId?: string };
		const stationId = str(body.stationId);
		if (!stationId || !store.get().stations.some((s) => s.stationId === stationId)) return fail(c, 400, "BAD_REQUEST", "unknown stationId");
		const row = c.get("sessionRow");
		await bindStation(row, stationId, "pick");
		return c.json(meOf(row));
	});

	// ----- checklists & runs
	api.get("/checklists", (c) => handle(c, async () => c.json(await engine.listPicks(c.get("sessionRow")))));

	api.post("/runs", (c) =>
		handle(c, async () => {
			const body = (await c.req.json().catch(() => ({}))) as { instanceId?: string; templateId?: string; stationId?: string; runId?: string };
			const row = c.get("sessionRow");
			const stationId = str(body.stationId) ?? row.stationId;
			if (!stationId) return fail(c, 400, "BAD_REQUEST", "stationId is required (select a station first)");
			return c.json(await engine.start(row, { instanceId: str(body.instanceId), templateId: str(body.templateId), stationId, runId: str(body.runId) }), 201);
		}),
	);
	api.get("/runs", (c) => c.json(engine.listRuns()));
	api.get("/runs/:id", (c) => handle(c, async () => c.json(engine.view(c.req.param("id")))));
	api.get("/runs/:id/next", (c) =>
		handle(c, async () => {
			const v = engine.view(c.req.param("id"));
			const item = v.items.find((i) => i.taskId === v.currentTaskId) ?? v.items.find((i) => i.voice && i.state === "unanswered");
			return c.json({ item: item ?? null, exchange: v.exchange, pendingReadback: v.pendingReadback ?? null });
		}),
	);
	api.post("/runs/:id/answer", (c) =>
		handle(c, async () => {
			const body = (await c.req.json().catch(() => ({}))) as { transcript?: string; taskId?: string; value?: string; valueText?: string };
			const row = c.get("sessionRow");
			const id = c.req.param("id");
			if (str(body.transcript)) {
				const v = engine.view(id);
				await engine.onTranscript(v.stationId, body.transcript as string, 1, row);
				return c.json(engine.view(id));
			}
			const v = engine.view(id);
			const taskId = str(body.taskId) ?? v.currentTaskId;
			if (!taskId || body.value === undefined) return fail(c, 400, "BAD_REQUEST", "transcript, or taskId + value, is required");
			return c.json(await engine.answerManual(id, taskId, String(body.value), row, str(body.valueText)));
		}),
	);
	api.post("/runs/:id/items/:taskId/answer", (c) =>
		handle(c, async () => {
			const body = (await c.req.json().catch(() => ({}))) as { value?: string; valueText?: string };
			if (body.value === undefined) return fail(c, 400, "BAD_REQUEST", "value is required");
			return c.json(await engine.answerManual(c.req.param("id"), c.req.param("taskId"), String(body.value), c.get("sessionRow"), str(body.valueText)));
		}),
	);
	api.post("/runs/:id/items/:taskId/jump", (c) => handle(c, async () => c.json(await engine.jumpTo(c.req.param("id"), c.req.param("taskId")))));
	api.post("/runs/:id/skip", (c) =>
		handle(c, async () => {
			const body = (await c.req.json().catch(() => ({}))) as { taskId?: string; reason?: string };
			return c.json(await engine.skip(c.req.param("id"), str(body.taskId), str(body.reason) ?? "skipped on screen"));
		}),
	);
	api.post("/runs/:id/repeat", (c) => handle(c, async () => c.json(await engine.repeat(c.req.param("id")))));
	api.post("/runs/:id/pause", (c) => handle(c, async () => c.json(await engine.pause(c.req.param("id")))));
	api.post("/runs/:id/resume", (c) => handle(c, async () => c.json(await engine.resume(c.req.param("id"), c.get("sessionRow")))));
	api.post("/runs/:id/complete", (c) => handle(c, async () => c.json(await engine.complete(c.req.param("id"), c.get("sessionRow")))));
	api.post("/runs/:id/discard", (c) =>
		handle(c, async () => {
			const body = (await c.req.json().catch(() => ({}))) as { reasonCode?: string; comment?: string };
			const reason = str(body.reasonCode);
			if (!reason) return fail(c, 400, "BAD_REQUEST", "reasonCode is required");
			return c.json(await engine.discard(c.req.param("id"), c.get("sessionRow"), reason, str(body.comment)));
		}),
	);
	api.post("/runs/:id/abandon", (c) => handle(c, async () => c.json(await engine.abandon(c.req.param("id"), "stopped on screen"))));
	// template ids may contain "/" (NauticAI/ArrivalChecklist): query, not path
	api.get("/template-items", (c) => handle(c, async () => c.json(await engine.templateItems(c.get("sessionRow"), c.req.query("templateId") ?? ""))));
	api.get("/templates/:id/discard-reasons", (c) =>
		handle(c, async () => {
			const id = c.req.param("id");
			return c.json({ reasons: await engine.discardReasons(c.get("sessionRow"), id === "any" ? undefined : id) });
		}),
	);
	api.post("/interpret", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { type?: string; text?: string; options?: { title: string; value: string }[]; answers?: unknown; answersOnly?: unknown };
		if (!str(body.type) || !str(body.text)) return fail(c, 400, "BAD_REQUEST", "type and text are required");
		return c.json(engine.preview(body.type as string, body.text as string, body.options, Array.isArray(body.answers) ? body.answers.filter((a): a is string => typeof a === "string") : undefined, body.answersOnly === true));
	});

	// ----- stations / devices / status (admin screens; every signed-in user can read, admins write)
	const requireAdmin = (c: Context<SessionEnv>): Response | undefined => {
		const u = store.get().users.find((x) => x.sub === c.get("sessionRow").sub);
		return u?.isAdmin ? undefined : fail(c, 403, "FORBIDDEN", "admin only");
	};

	const joinKey = deriveKey(env.secret);
	/** Every station has its own client link; the token is kept sealed so Admin can show it again. */
	const mintJoin = (d: HubData, stationId: string, sub: string | undefined): string => {
		const token = newJoinToken();
		const createdAt = new Date(deps.now()).toISOString();
		d.stationJoins[stationId] = { stationId, tokenHash: hashDeckToken(token), tokenHint: tokenHint(token), sealed: sealToken(token, joinKey), createdAt, createdBy: sub };
		d.audit.push({ at: createdAt, kind: "station.join.rotated", stationId, sub });
		return token;
	};
	const ensureJoins = async (sub?: string): Promise<void> => {
		const d0 = store.get();
		if (d0.stations.every((s) => d0.stationJoins[s.stationId])) return;
		await store.update((d) => {
			for (const s of d.stations) if (!d.stationJoins[s.stationId]) mintJoin(d, s.stationId, sub);
		});
	};
	const isAdminCtx = (c: Context<SessionEnv>): boolean => !!store.get().users.find((x) => x.sub === c.get("sessionRow").sub)?.isAdmin;

	const stationViews = (withLinks = false): StationView[] => {
		const eps = deps.gateway.stations();
		return store.get().stations.map((s) => {
			const ep = eps.find((e) => e.stationId === s.stationId);
			const run = engine.activeRun(s.stationId);
			const v: StationView = { ...s };
			const j = store.get().stationJoins[s.stationId];
			if (j) {
				v.join = { tokenHint: j.tokenHint, createdAt: j.createdAt, createdBy: j.createdBy };
				if (withLinks && j.sealed) {
					try {
						v.join.path = `/client#/join/${openToken(j.sealed, joinKey)}`;
					} catch {
						/* sealed with another HUB_SECRET: rotate to get a link again */
					}
				}
			}
			if (ep) v.endpoint = { endpointId: ep.endpointId, user: ep.user, observers: ep.observers, aec: ep.caps.aec, pushToTalk: ep.caps.pushToTalk, localStt: ep.caps.localStt, localTts: ep.caps.localTts };
			if (run) {
				const view = engine.toView(run);
				v.activeRun = { runId: run.runId, templateName: run.templateName, state: run.state, answered: view.answered, total: view.total };
			}
			return v;
		});
	};

	api.get("/stations", async (c) => {
		if (isAdminCtx(c)) await ensureJoins(c.get("sessionRow").sub);
		return c.json(stationViews(isAdminCtx(c)));
	});
	api.put("/stations", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const body = (await c.req.json().catch(() => undefined)) as Station[] | undefined;
		if (!Array.isArray(body) || !body.every((s) => isObj(s) && str(s.stationId) && str(s.name))) return fail(c, 400, "BAD_REQUEST", "array of stations expected");
		await store.update((d) => {
			d.stations = body.map((s) => ({ stationId: s.stationId, name: s.name, location: str(s.location), defaultProfile: s.defaultProfile ?? null, language: s.language || "en", audioPolicy: s.audioPolicy === "open" ? "open" : "ptt", autoStartAllowed: !!s.autoStartAllowed, verbosity: s.verbosity ?? "full", voiceActions: s.voiceActions !== false, holdToAnswer: s.holdToAnswer === true, templates: templateRules(s.templates) }));
			for (const id of Object.keys(d.stationJoins)) if (!d.stations.some((s) => s.stationId === id)) delete d.stationJoins[id];
		});
		await ensureJoins(c.get("sessionRow").sub);
		return c.json(stationViews(true));
	});

	// ----- station QR join tokens (admin). The token is returned once; only its hash is kept.
	api.post("/stations/:id/join-token", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const id = c.req.param("id");
		if (!store.get().stations.some((s) => s.stationId === id)) return fail(c, 404, "STATION_NOT_FOUND", "unknown station");
		const sub = c.get("sessionRow").sub;
		let token = "";
		await store.update((d) => {
			token = mintJoin(d, id, sub);
		});
		const join = store.get().stationJoins[id];
		const createdAt = join.createdAt;
		log.info(`station ${id} link rotated by ${sub} (…${join.tokenHint})`);
		const path = `/client#/join/${token}`;
		const base = env.publicUrl ? env.publicUrl.replace(/\/$/, "") : new URL(c.req.url).origin;
		return c.json<JoinTokenResponse>({ stationId: id, token, tokenHint: join.tokenHint, createdAt, path, url: base + path }, 201);
	});
	api.delete("/stations/:id/join-token", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const id = c.req.param("id");
		const sub = c.get("sessionRow").sub;
		await store.update((d) => {
			if (d.stationJoins[id]) {
				delete d.stationJoins[id];
				d.audit.push({ at: new Date(deps.now()).toISOString(), kind: "station.join.revoked", stationId: id, sub });
			}
		});
		log.info(`station ${id} QR join token revoked by ${sub}`);
		return c.json({ ok: true });
	});

	api.get("/status", async (c) => {
		if (isAdminCtx(c)) await ensureJoins(c.get("sessionRow").sub);
		const d = store.get();
		const res: StatusResponse = {
			hubVersion: deps.version,
			uptimeSec: Math.round(deps.uptime()),
			stations: stationViews(isAdminCtx(c)),
			runs: engine.listRuns(),
			outbox: { queued: d.outbox.filter((o) => o.state === "queued").length, failed: d.outbox.filter((o) => o.state === "failed").length, entries: d.outbox.slice(-100) },
			devices: d.devices,
			pendingEnrollments: d.pendingEnrollments.filter((p) => !p.token),
			sessions: d.sessions.map((s) => ({ id: s.id, sub: s.sub, name: d.users.find((u) => u.sub === s.sub)?.name, stationId: s.stationId, lastSeenAt: s.lastSeenAt, createdAt: s.createdAt, credential: s.credential?.state ?? (s.sub.startsWith("dev:") ? "dev" : "none") })),
			prompts: d.prompts.slice(-50).map((p) => ({ promptId: p.promptId, stationId: p.stationId, prompt: p.item.prompt, state: p.state, createdAt: p.createdAt })),
			speech: { stt: env.speech.sttMode, tts: env.speech.ttsMode, sttUrl: env.speech.sttUrl, sttBackup: !!deps.sttBackup, sttBackupUrl: env.speech.sttBackupUrl },
			settings: d.settings,
		};
		return c.json(res);
	});

	api.get("/audit", (c) => {
		const limit = Math.min(1000, Number(c.req.query("limit") ?? 200));
		const runId = c.req.query("runId");
		const rows = store.get().audit.filter((a) => !runId || a.runId === runId);
		return c.json(rows.slice(-limit).reverse());
	});

	api.post("/devices/approve", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const body = (await c.req.json().catch(() => ({}))) as { code?: string; stationId?: string };
		const code = str(body.code);
		const p = store.get().pendingEnrollments.find((x) => x.code === code && !x.token);
		if (!p) return fail(c, 404, "NOT_FOUND", "no pending enrollment with that code");
		const token = newDeckToken();
		const device: Device = { deviceId: newDeckId(), name: p.deviceName, kind: p.kind, tokenHash: hashDeckToken(token), tokenHint: tokenHint(token), enrolledAt: new Date(deps.now()).toISOString(), stationId: str(body.stationId) };
		await store.update((d) => {
			d.devices.push(device);
			const x = d.pendingEnrollments.find((q) => q.code === code);
			if (x) {
				x.token = token;
				x.deviceId = device.deviceId;
				x.approvedAt = device.enrolledAt;
			}
		});
		log.info(`device "${device.name}" approved by ${c.get("sessionRow").sub}`);
		return c.json(device, 201);
	});
	api.delete("/devices/:id", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const id = c.req.param("id");
		await store.update((d) => {
			const x = d.devices.find((q) => q.deviceId === id);
			if (x) x.revoked = true;
		});
		deps.gateway.dropDevice(id);
		return c.json({ ok: true });
	});
	api.delete("/sessions/:id", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const ok = await auth.revokeSession(c.req.param("id"));
		deps.gateway.dropSession(c.req.param("id"));
		return c.json({ ok });
	});
	api.put("/users/:sub/admin", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const body = (await c.req.json().catch(() => ({}))) as { isAdmin?: boolean };
		await store.update((d) => {
			const u = d.users.find((x) => x.sub === c.req.param("sub"));
			if (u) u.isAdmin = !!body.isAdmin;
		});
		return c.json({ ok: true });
	});
	api.get("/users", (c) => c.json(store.get().users));

	api.get("/profiles", (c) => c.json(store.get().profiles));
	api.put("/profiles/:id", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const body = (await c.req.json().catch(() => undefined)) as VoiceProfile | undefined;
		if (!body || !isObj(body) || !Array.isArray(body.bindings)) return fail(c, 400, "BAD_REQUEST", "profile expected");
		const profile: VoiceProfile = { ...body, profileId: c.req.param("id") };
		await store.update((d) => {
			d.profiles = d.profiles.filter((p) => p.profileId !== profile.profileId);
			d.profiles.push(profile);
		});
		return c.json(profile);
	});
	api.delete("/profiles/:id", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		await store.update((d) => {
			d.profiles = d.profiles.filter((p) => p.profileId !== c.req.param("id"));
		});
		return c.json({ ok: true });
	});
	api.get("/mappings", (c) => c.json(store.get().mappings));
	api.put("/mappings", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const body = (await c.req.json().catch(() => undefined)) as EventMapping[] | undefined;
		if (!Array.isArray(body)) return fail(c, 400, "BAD_REQUEST", "array expected");
		await store.update((d) => {
			d.mappings = body.filter((m) => isObj(m) && str(m.on) && str(m.start) && str(m.station));
		});
		return c.json(store.get().mappings);
	});
	// ----- backup recognition: the device sends the PCM of ONE listen window it could not transcribe itself.
	// One transcription at a time (the recogniser is CPU-bound; a queue keeps the box responsive), audio is never stored.
	const STT_MAX_BYTES = 16000 * 2 * 8; // 8 s of 16 kHz mono 16-bit: an answer, not a conversation (the recogniser encodes 7.7 s)
	let sttQueue: Promise<unknown> = Promise.resolve();
	let sttWaiting = 0;
	// Server-side voice: the sentence the hub wants spoken, as a WAV from the voice server. Signed-in clients only.
	api.get("/tts", async (c) => {
		if (!deps.tts) return fail(c, 404, "TTS_OFF", "this hub has no voice server (TTS_ENDPOINT)");
		const text = (c.req.query("text") ?? "").trim();
		const lang = c.req.query("lang") ?? "en";
		if (!text || text.length > MAX_TTS_CHARS) return fail(c, 400, "BAD_REQUEST", `text is required, at most ${MAX_TTS_CHARS} characters`);
		if (!deps.tts.supports(lang)) return fail(c, 404, "TTS_NO_VOICE", `no server voice for ${lang}`);
		try {
			const wav = await deps.tts.speak(text, lang);
			return c.body(new Uint8Array(wav), 200, { "content-type": "audio/wav", "cache-control": "private, max-age=3600" });
		} catch (err) {
			log.warn(`voice server: ${err instanceof Error ? err.message : String(err)}`);
			return fail(c, 502, "TTS_FAILED", "the voice server did not answer");
		}
	});

	api.post("/stt", async (c) => {
		const backup = deps.sttBackup;
		if (!backup) return fail(c, 404, "STT_BACKUP_OFF", "no backup recogniser is configured on this hub");
		if (sttWaiting >= 4) return fail(c, 429, "RATE_LIMITED", "the recogniser is busy");
		const buf = Buffer.from(await c.req.arrayBuffer());
		if (buf.length < 3200) return c.json({ text: "" }); // under 100 ms: nothing to hear
		if (buf.length > STT_MAX_BYTES) return fail(c, 400, "BAD_REQUEST", "audio too long");
		const language = str(c.req.query("language"))?.slice(0, 2).toLowerCase();
		const bias = (str(c.req.query("prompt")) ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 40);
		sttWaiting++;
		const job = sttQueue.then(() => backup.transcribe(buf, { language: language === "nb" ? "no" : language, bias }));
		sttQueue = job.catch(() => undefined);
		try {
			const started = deps.now();
			const r = await job;
			log.info(`backup stt (${language ?? "?"}, ${(buf.length / 32000).toFixed(1)} s audio) → ${r.text ? `${r.text.split(/\s+/).length} word(s)` : "nothing"} in ${deps.now() - started} ms`);
			return c.json({ text: r.text, confidence: r.confidence });
		} catch (err) {
			log.warn(`backup stt failed: ${err instanceof Error ? err.message : String(err)}`);
			return fail(c, 502, "STT_BACKUP_FAILED", "the backup recogniser did not answer");
		} finally {
			sttWaiting--;
		}
	});

	const models = new SpeechModels(env.dataDir, log);
	// admin: fetch a model onto the hub ahead of time, so the first phone does not wait for it
	api.post("/models/vosk/:lang", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const lang = c.req.param("lang");
		if (!VOSK_MODELS[lang]) return fail(c, 404, "MODEL_UNKNOWN", "no such speech model");
		void models.ensure(lang).catch((err) => log.warn(`speech model ${lang}: ${err instanceof Error ? err.message : String(err)}`));
		return c.json(await models.list());
	});
	// ----- central checklist register (Admin → Checklist setup); template ids may contain "/" so they travel in the body / query
	const libraryView = (): LibraryView => {
		const d = store.get();
		return { templates: Object.values(d.library ?? {}).sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ ...t, language: d.settings.templateLanguages?.[t.templateId], words: d.settings.itemAnswers?.[t.templateId] ?? {}, wordsOnly: !!d.settings.wordsOnly?.includes(t.templateId) })) };
	};
	api.get("/library", (c) => c.json(libraryView()));
	api.get("/library/available", (c) => handle(c, async () => c.json({ templates: await engine.availableTemplates(c.get("sessionRow")) })));
	api.post("/library", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const body = (await c.req.json().catch(() => ({}))) as { templateId?: unknown };
		const id = str(body.templateId);
		if (!id) return fail(c, 400, "BAD_REQUEST", "templateId is required");
		return handle(c, async () => {
			await engine.registerTemplate(c.get("sessionRow"), id);
			return c.json(libraryView());
		});
	});
	api.delete("/library", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const id = c.req.query("templateId") ?? "";
		await store.update((d) => {
			if (d.library) delete d.library[id];
			for (const st of d.stations) {
				if (st.templates) delete st.templates[id];
				if (st.templates && !Object.keys(st.templates).length) delete st.templates;
			}
		});
		return c.json(libraryView());
	});
	/** Language and trigger words of one registered checklist. `words`: item key → words. */
	api.put("/library/entry", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const body = (await c.req.json().catch(() => ({}))) as { templateId?: unknown; language?: unknown; words?: unknown; wordsOnly?: unknown };
		const id = str(body.templateId);
		if (!id || !store.get().library?.[id]) return fail(c, 404, "NOT_FOUND", "checklist is not in the register");
		await store.update((d) => {
			if (typeof body.wordsOnly === "boolean") {
				const rest = (d.settings.wordsOnly ?? []).filter((x) => x !== id);
				d.settings.wordsOnly = body.wordsOnly ? [...rest, id] : rest;
			}
			if (body.language !== undefined) {
				const langs = (d.settings.templateLanguages ??= {});
				if (typeof body.language === "string" && /^(en|sv|no|fr|de)$/.test(body.language)) langs[id] = body.language;
				else delete langs[id];
			}
			if (isObj(body.words)) {
				const per: Record<string, string[]> = {};
				for (const [key, words] of Object.entries(body.words)) {
					const list = Array.isArray(words) ? [...new Set(words.filter((w): w is string => typeof w === "string").map((w) => w.trim().toLowerCase().slice(0, 60)).filter(Boolean))].slice(0, 12) : [];
					if (/^[dn]:/.test(key) && list.length) per[key] = list;
				}
				const all = (d.settings.itemAnswers ??= {});
				if (Object.keys(per).length) all[id] = per;
				else delete all[id];
			}
		});
		return c.json(libraryView());
	});

	api.put("/settings", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		const body = (await c.req.json().catch(() => ({}))) as Partial<StatusResponse["settings"]>;
		await store.update((d) => {
			if (typeof body.readNotices === "boolean") d.settings.readNotices = body.readNotices;
			if (body.tzMode === "utc" || body.tzMode === "local") d.settings.tzMode = body.tzMode;
			if (body.confirmation === "required" || body.confirmation === "optional") d.settings.confirmation = body.confirmation;
			if (isObj(body.templateLanguages)) {
				const next: Record<string, string> = {};
				for (const [id, lang] of Object.entries(body.templateLanguages)) if (typeof lang === "string" && /^(en|sv|no|fr|de)$/.test(lang)) next[id] = lang;
				d.settings.templateLanguages = next;
			}
			if (isObj(body.itemAnswers)) {
				const all: Record<string, Record<string, string[]>> = {};
				for (const [tpl, items] of Object.entries(body.itemAnswers)) {
					if (!isObj(items)) continue;
					const per: Record<string, string[]> = {};
					for (const [key, words] of Object.entries(items)) {
						const list = Array.isArray(words) ? [...new Set(words.filter((w): w is string => typeof w === "string").map((w) => w.trim().slice(0, 60)).filter(Boolean))].slice(0, 12) : [];
						if (/^[dn]:/.test(key) && list.length) per[key] = list;
					}
					if (Object.keys(per).length) all[tpl] = per;
				}
				d.settings.itemAnswers = all;
			}
			if (Array.isArray(body.startable)) d.settings.startable = [...new Set(body.startable.filter((x): x is string => typeof x === "string" && !!x.trim()))];
		});
		return c.json(store.get().settings);
	});
	api.post("/outbox/retry", async (c) => {
		await store.update((d) => {
			for (const o of d.outbox) if (o.state === "failed") {
				o.state = "queued";
				o.nextAt = new Date(deps.now()).toISOString();
			}
		});
		return c.json(await deps.outbox.drain());
	});
	api.delete("/outbox/:id", async (c) => {
		const denied = requireAdmin(c);
		if (denied) return denied;
		await store.update((d) => {
			d.outbox = d.outbox.filter((o) => o.id !== c.req.param("id"));
		});
		return c.json({ ok: true });
	});
	api.post("/prompts/:id/cancel", (c) => handle(c, async () => c.json({ ok: await engine.cancelPrompt(c.req.param("id")) })));

	app.route("/api", api);

	// ============================================================ /v1 (integrations: Flow, Elsa, schedulers)
	const v1 = new Hono();

	/** A repeated Idempotency-Key answers the stored result before any validation (vessel event streams repeat and retry). */
	const replay = (c: Context): Response | undefined => {
		const key = c.req.header("idempotency-key");
		const hit = key ? store.get().idempotency[key] : undefined;
		if (!hit) return undefined;
		c.header("Idempotent-Replayed", "true");
		return c.json(JSON.parse(hit.result) as Record<string, unknown>, 200);
	};
	const idempotent = async (c: Context, fn: () => Promise<{ status: number; body: unknown }>): Promise<Response> => {
		const key = c.req.header("idempotency-key");
		const replayed = replay(c);
		if (replayed) return replayed;
		const r = await fn();
		if (key) await store.update((d) => void (d.idempotency[key] = { at: new Date(deps.now()).toISOString(), result: JSON.stringify(r.body) }));
		return c.json(r.body as Record<string, unknown>, r.status as 200);
	};

	/** Service token, or a webhook HMAC (`X-Flow-Signature: sha256=…` over the raw body) with an optional `X-Flow-Source`. */
	const integrationAuth = async (c: Context): Promise<{ ok: true; raw: string; source?: string; trusted: boolean } | { ok: false; res: Response }> => {
		const raw = await c.req.text();
		if (serviceAuthorized(c)) return { ok: true, raw, source: c.req.header("x-flow-source") ?? "service", trusted: true };
		const sig = c.req.header("x-flow-signature");
		const source = c.req.header("x-flow-source") ?? "*";
		const secret = env.webhookSecrets[source] ?? env.webhookSecrets["*"];
		if (sig && secret && hmacOk(secret, raw, sig)) {
			const ts = Number(c.req.header("x-flow-timestamp") ?? "0");
			if (ts && Math.abs(deps.now() / 1000 - ts) > 300) return { ok: false, res: fail(c, 401, "REPLAY", "timestamp outside the 5 minute window") };
			return { ok: true, raw, source, trusted: true };
		}
		if (!env.serviceTokens.length && !Object.keys(env.webhookSecrets).length) return { ok: false, res: fail(c, 401, "UNAUTHORIZED", "set SERVICE_TOKENS or WEBHOOK_SECRET on the hub") };
		return { ok: false, res: fail(c, 401, "UNAUTHORIZED", "bearer service token or X-Flow-Signature required") };
	};

	v1.post("/prompts", (c) =>
		handle(c, async () => {
			const a = await integrationAuth(c);
			if (!a.ok) return a.res;
			const replayed = replay(c);
			if (replayed) return replayed;
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(a.raw) as Record<string, unknown>;
			} catch {
				return fail(c, 400, "BAD_REQUEST", "JSON body expected");
			}
			const target = isObj(body.target) ? body.target : {};
			const checklist = isObj(body.checklist) ? body.checklist : {};
			const item = isObj(body.item) ? body.item : {};
			const policy = isObj(body.policy) ? body.policy : {};
			const stationId = str(target.stationId);
			const instanceId = str(checklist.instanceId);
			const prompt = str(item.prompt);
			const type = isObj(item.expect) ? str(item.expect.type) : undefined;
			if (!stationId || !instanceId || !prompt || !type) return fail(c, 400, "BAD_REQUEST", "target.stationId, checklist.instanceId, item.prompt and item.expect.type are required");
			if (!store.get().stations.some((s) => s.stationId === stationId)) return fail(c, 404, "STATION_NOT_FOUND", `unknown station ${stationId}`);
			return idempotent(c, async () => {
				const rec: PromptRecord = {
					promptId: `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
					createdAt: new Date(deps.now()).toISOString(),
					stationId,
					instanceId,
					templateId: str(checklist.templateId),
					templateName: str(checklist.templateName),
					item: { dataId: str(item.dataId), taskId: str(item.taskId), prompt, expect: { type }, language: str(item.language), options: Array.isArray(item.options) ? (item.options as { title: string; value: string }[]) : undefined },
					policy: { confirmation: policy.confirmation === "none" ? "none" : "required", priority: policy.priority === "high" ? "high" : "normal", timeoutSec: Number(policy.timeoutSec) || 60, retries: Number(policy.retries) || 2 },
					callbackUrl: str(body.callbackUrl),
					state: "queued",
					idempotencyKey: c.req.header("idempotency-key"),
				};
				await engine.enqueuePrompt(rec);
				const position = store.get().prompts.filter((p) => p.stationId === stationId && p.state === "queued").length - 1;
				return { status: 202, body: { promptId: rec.promptId, state: "queued", queuePosition: Math.max(0, position) } };
			});
		}),
	);
	v1.get("/prompts/:id", (c) => {
		const p = store.get().prompts.find((x) => x.promptId === c.req.param("id"));
		return p ? c.json(p) : fail(c, 404, "NOT_FOUND", "unknown prompt");
	});
	v1.post("/prompts/:id/cancel", (c) =>
		handle(c, async () => {
			const a = await integrationAuth(c);
			if (!a.ok) return a.res;
			const replayed = replay(c);
			if (replayed) return replayed;
			return c.json({ ok: await engine.cancelPrompt(c.req.param("id")) });
		}),
	);
	v1.post("/runs/trigger", (c) =>
		handle(c, async () => {
			const a = await integrationAuth(c);
			if (!a.ok) return a.res;
			const replayed = replay(c);
			if (replayed) return replayed;
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(a.raw) as Record<string, unknown>;
			} catch {
				return fail(c, 400, "BAD_REQUEST", "JSON body expected");
			}
			const trig = isObj(body.trigger) ? body.trigger : {};
			const eventType = str(trig.type) ?? "external";
			// mapping file first (keeps the rule with the vessel), explicit fields override
			const mapping = store.get().mappings.find((m) => m.on === eventType);
			const templateId = str(body.templateId) ?? mapping?.start;
			const stationId = str(body.stationId) ?? mapping?.station;
			if (!templateId || !stationId) return fail(c, 400, "BAD_REQUEST", "templateId and stationId are required (or a mapping for trigger.type)");
			if (mapping?.debounceMin && mapping.lastFiredAt && deps.now() - Date.parse(mapping.lastFiredAt) < mapping.debounceMin * 60_000) return c.json({ state: "debounced" }, 202);
			return idempotent(c, async () => {
				if (mapping) await store.update((d) => void (d.mappings.find((m) => m === mapping || m.on === mapping.on)!.lastFiredAt = new Date(deps.now()).toISOString()));
				const run = await engine.trigger({ templateId, stationId, trigger: { type: eventType, at: str(trig.at), source: a.source }, autoStart: body.autoStart === true || mapping?.autoStart === true, trusted: a.trusted && (mapping?.trusted ?? a.source === "service"), callbackUrl: str(body.callbackUrl), language: str(body.language) });
				return { status: 202, body: { runId: run.runId, state: run.state } };
			});
		}),
	);
	// ---- run control for integrations (service token / HMAC). Items are addressed by task id or DataId.
	const runItemView = (runId: string) => {
		const v = engine.view(runId);
		const item = v.items.find((i) => i.taskId === v.currentTaskId) ?? null;
		return { runId: v.runId, state: v.state, exchange: v.exchange, templateName: v.templateName, instanceId: v.instanceId, stationId: v.stationId, answered: v.answered, total: v.total, currentItem: item, pendingReadback: v.pendingReadback ?? null, lastSpoken: v.lastSpoken };
	};
	const withRun = (c: Context, fn: (runId: string, body: Record<string, unknown>) => Promise<Response>) =>
		handle(c, async () => {
			const a = await integrationAuth(c);
			if (!a.ok) return a.res;
			let body: Record<string, unknown> = {};
			if (a.raw.trim()) {
				try {
					body = JSON.parse(a.raw) as Record<string, unknown>;
				} catch {
					return fail(c, 400, "BAD_REQUEST", "JSON body expected");
				}
			}
			return fn(c.req.param("id") ?? "", body);
		});

	v1.post("/runs", (c) =>
		handle(c, async () => {
			const a = await integrationAuth(c);
			if (!a.ok) return a.res;
			const replayed = replay(c);
			if (replayed) return replayed;
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(a.raw) as Record<string, unknown>;
			} catch {
				return fail(c, 400, "BAD_REQUEST", "JSON body expected");
			}
			const stationId = str(body.stationId);
			const instanceId = str(body.instanceId);
			const templateId = str(body.templateId);
			if (!stationId || (!instanceId && !templateId)) return fail(c, 400, "BAD_REQUEST", "stationId and instanceId or templateId are required");
			if (!store.get().stations.some((s) => s.stationId === stationId)) return fail(c, 404, "STATION_NOT_FOUND", `unknown station ${stationId}`);
			return idempotent(c, async () => {
				const r = await engine.startFromService({ stationId, instanceId, templateId, item: str(body.item) ?? str(body.dataId), source: a.source, callbackUrl: str(body.callbackUrl), language: str(body.language) });
				return { status: r.started ? 201 : 202, body: { ...runItemView(r.run.runId), started: r.started } };
			});
		}),
	);
	v1.get("/runs", async (c) => {
		const a = await integrationAuth(c);
		if (!a.ok) return a.res;
		const stationId = c.req.query("stationId");
		return c.json(engine.listRuns().filter((r) => !stationId || r.stationId === stationId));
	});
	v1.get("/runs/:id/next", (c) => handle(c, async () => c.json(runItemView(c.req.param("id")))));
	v1.get("/runs/:id/items", (c) => handle(c, async () => c.json(engine.view(c.req.param("id")).items)));
	v1.get("/runs/:id/items/:ref", (c) =>
		handle(c, async () => {
			const it = engine.resolveItem(c.req.param("id"), c.req.param("ref"));
			return it ? c.json(it) : fail(c, 404, "ITEM_NOT_FOUND", "no such item (task id or DataId)");
		}),
	);
	v1.post("/runs/:id/items/:ref/jump", (c) =>
		withRun(c, async (runId) => {
			const it = engine.resolveItem(runId, c.req.param("ref"));
			if (!it) return fail(c, 404, "ITEM_NOT_FOUND", "no such item (task id or DataId)");
			await engine.jumpTo(runId, it.taskId);
			return c.json(runItemView(runId));
		}),
	);
	v1.post("/runs/:id/items/:ref/answer", (c) =>
		withRun(c, async (runId, body) => {
			const it = engine.resolveItem(runId, c.req.param("ref"));
			if (!it) return fail(c, 404, "ITEM_NOT_FOUND", "no such item (task id or DataId)");
			const session = engine.actingSession(runId);
			if (!session) return fail(c, 409, "NO_USER", "no signed-in user to attribute the value to");
			if (body.value === undefined) return fail(c, 400, "BAD_REQUEST", "value is required");
			await engine.answerManual(runId, it.taskId, String(body.value), session, str(body.valueText));
			return c.json(runItemView(runId));
		}),
	);
	v1.post("/runs/:id/answer", (c) =>
		withRun(c, async (runId, body) => {
			const text = str(body.transcript);
			if (!text) return fail(c, 400, "BAD_REQUEST", "transcript is required (use items/{ref}/answer for typed values)");
			const v = engine.view(runId);
			await engine.onTranscript(v.stationId, text, 1, engine.actingSession(runId));
			return c.json(runItemView(runId));
		}),
	);
	v1.post("/runs/:id/next", (c) => withRun(c, async (runId) => c.json(await engine.next(runId).then(() => runItemView(runId)))));
	v1.post("/runs/:id/skip", (c) => withRun(c, async (runId, body) => c.json(await engine.skip(runId, str(body.taskId) ?? str(body.dataId), str(body.reason) ?? "skipped by API").then(() => runItemView(runId)))));
	v1.post("/runs/:id/repeat", (c) => withRun(c, async (runId) => c.json(await engine.repeat(runId).then(() => runItemView(runId)))));
	v1.post("/runs/:id/pause", (c) => withRun(c, async (runId) => c.json(await engine.pause(runId).then(() => runItemView(runId)))));
	v1.post("/runs/:id/resume", (c) => withRun(c, async (runId) => c.json(await engine.resume(runId, engine.actingSession(runId)).then(() => runItemView(runId)))));
	v1.post("/runs/:id/complete", (c) =>
		withRun(c, async (runId) => {
			const session = engine.actingSession(runId);
			if (!session) return fail(c, 409, "NO_USER", "no signed-in user to complete as");
			return c.json(await engine.complete(runId, session));
		}),
	);
	v1.post("/runs/:id/discard", (c) =>
		withRun(c, async (runId, body) => {
			const session = engine.actingSession(runId);
			if (!session) return fail(c, 409, "NO_USER", "no signed-in user to discard as");
			return c.json(await engine.discard(runId, session, str(body.reasonCode) ?? "other", str(body.comment)));
		}),
	);
	v1.post("/runs/:id/abandon", (c) => withRun(c, async (runId) => c.json(await engine.abandon(runId, "stopped by API"))));

	v1.get("/stations", (c) => c.json(stationViews()));
	v1.get("/checklists", async (c) => {
		const row = await sessionFromRequest(c);
		if (!row) return fail(c, 401, "UNAUTHORIZED", "login required");
		return handle(c, async () => c.json(await engine.listPicks(row)));
	});
	v1.get("/runs/:id", (c) => handle(c, async () => c.json(engine.view(c.req.param("id")))));
	app.route("/v1", v1);

	// ============================================================ ops
	app.get("/healthz", (c) => c.text("ok"));

	// ----- speech models for the phones (public data, no sign-in: the Android agent downloads them outside the WebView)
	app.get("/models/vosk", async (c) => c.json(await models.list()));
	app.get("/models/vosk/:file", async (c) => {
		const m = /^([a-z]{2})\.zip$/.exec(c.req.param("file"));
		if (!m || !VOSK_MODELS[m[1]]) return fail(c, 404, "MODEL_UNKNOWN", "no such speech model");
		try {
			const { stream, bytes } = await models.open(m[1]);
			return new Response(stream, { headers: { "content-type": "application/zip", "content-length": String(bytes), "cache-control": "public, max-age=86400" } });
		} catch (err) {
			log.warn(`speech model ${m[1]} unavailable: ${err instanceof Error ? err.message : String(err)}`);
			return fail(c, 502, "MODEL_UNAVAILABLE", `the hub has no copy of this model and could not fetch it (${err instanceof Error ? err.message : String(err)})`);
		}
	});
	app.get("/readyz", (c) => c.text(env.maranics ? "ready" : "degraded: Maranics not configured", env.maranics ? 200 : 503));
	app.get("/metrics", (c) => {
		const d = store.get();
		const lines = [
			`# TYPE flowvoice_outbox_queued gauge`,
			`flowvoice_outbox_queued ${d.outbox.filter((o) => o.state === "queued").length}`,
			`# TYPE flowvoice_outbox_failed gauge`,
			`flowvoice_outbox_failed ${d.outbox.filter((o) => o.state === "failed").length}`,
			`# TYPE flowvoice_runs_active gauge`,
			`flowvoice_runs_active ${d.runs.filter((r) => r.state === "active").length}`,
			`# TYPE flowvoice_endpoints gauge`,
			`flowvoice_endpoints ${deps.gateway.stations().length}`,
			`# TYPE flowvoice_uptime_seconds counter`,
			`flowvoice_uptime_seconds ${Math.round(deps.uptime())}`,
		];
		return c.text(`${lines.join("\n")}\n`);
	});

	// ============================================================ static PWA
	const indexPath = `${env.publicDir}/index.html`;
	app.get("*", async (c) => {
		const path = new URL(c.req.url).pathname;
		if (path.startsWith("/api/") || path.startsWith("/v1/")) return fail(c, 404, "NOT_FOUND", "no such route");
		const file = resolveStatic(env.publicDir, path, existsSync);
		if (file) {
			const body = readFileSync(file.filePath);
			c.header("Content-Type", file.contentType);
			c.header("Cache-Control", file.cacheControl);
			return c.body(body);
		}
		if (existsSync(indexPath)) {
			c.header("Content-Type", "text/html; charset=utf-8");
			c.header("Cache-Control", "no-cache");
			return c.body(readFileSync(indexPath));
		}
		return c.text("Flow Voice hub is running. The web app is not built (npm run build:web).", 200);
	});

	return app;
}

/** Authenticate a WebSocket upgrade with the same cookie / device token rules as the HTTP API. */
export function upgradeAuthenticator(deps: { env: HubEnv; store: HubStore; now(): number }) {
	return async (req: import("node:http").IncomingMessage): Promise<{ session?: HubSession; deviceId?: string } | undefined> => {
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
		const c = { req: { raw: new Request(`http://hub${req.url ?? "/"}`, { headers }) } } as unknown as Context;
		const claims = await readSession(c, deps.env.sessionSecret);
		let session: HubSession | undefined;
		if (claims && validSession(claims, deps.now(), deps.store.get().sessionEpoch)) {
			const row = deps.store.get().sessions.find((s) => s.sidHash === sidHash(claims.sid));
			if (row && row.sub === claims.sub) session = row;
		}
		let deviceId: string | undefined;
		const cookie = req.headers.cookie ?? "";
		const m = /(?:^|;\s*)fv_device=([^;]+)/.exec(cookie);
		const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
		const token = bearer ?? m?.[1] ?? (typeof req.headers["x-device-token"] === "string" ? req.headers["x-device-token"] : undefined);
		if (token) {
			const d = deps.store.get().devices.find((x) => !x.revoked && verifyDeckToken(token, x.tokenHash));
			if (d) {
				deviceId = d.deviceId;
				d.lastSeenAt = new Date(deps.now()).toISOString();
			}
		}
		if (!session && !deviceId) return undefined;
		return { session, deviceId };
	};
}

export { LOGIN_COOKIE };
