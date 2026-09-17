/**
 * Light multi-tenancy for trying other Maranics tenants: an admin of the main hub pastes an access token for another
 * tenant; that tenant then runs as its own isolated hub core (own data folder, stations, checklist register, runs)
 * inside this process. A signed `fv_tenant` cookie picks the core per request.
 *
 * Who gets in: an admin of the main hub ("enter"), or anyone holding a station link of that tenant (the join token is
 * the secret). Everyone inside a token tenant acts with the pasted token, so Flow attributes the writes to its owner.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Logger } from "./core/log.js";
import { registerSecret } from "./core/redact.js";
import type { HubEnv } from "./env.js";
import { ROLE_HEADER, SESSION_COOKIE, readSession, sidHash, validSession } from "./http/session.js";
export { SESSION_COOKIE };
import { LOGIN_LIMITS, RateLimiter } from "./http/rateLimit.js";
import { openToken, sealToken, verifyDeckToken } from "./store/crypto.js";
import type { HubStore, TenantEntry } from "./store/HubStore.js";

export const TENANT_COOKIE = "fv_tenant";
/** Signed-in marker of the central admin area: `<expiryMs>.<hmac>`, 12 hours. */
export const CENTRAL_COOKIE = "fv_central";
const CENTRAL_TTL_MS = 12 * 3600_000;
/** Set by the dispatcher (never trusted from outside): how the caller got into a token tenant. */
export { ROLE_HEADER };
export type TenantRole = "admin" | "client";
const MAX_AGE_SEC = 30 * 86400;

export interface Core {
	fetch(req: Request): Response | Promise<Response>;
	handleUpgrade(req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): Promise<boolean>;
	store: HubStore;
	stop(): void;
}

export interface TenantView {
	id: string;
	name: string;
	tenant: string;
	host?: string;
	tokenHint: string;
	/** From the token's own `exp` claim when it is a JWT. */
	tokenExpiresAt?: string;
	createdAt: string;
}
export interface TenantsResponse {
	/** The token tenant this browser is in; absent = the main hub. */
	current?: { id: string; name: string };
	canManage: boolean;
	/** True when tenants are managed in the central admin area (`/central`) rather than by main-hub admins. */
	central: boolean;
	mainName: string;
	tenants: TenantView[];
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
/** Unverified peek into a JWT: only for showing "expires at" and a user name. */
export function peekJwt(token: string): { exp?: number; name?: string } {
	try {
		const p = JSON.parse(b64url(token.split(".")[1] ?? "")) as Record<string, unknown>;
		const name = [p.name, p.preferred_username, p.email, p.sub].find((x): x is string => typeof x === "string" && !!x);
		return { exp: typeof p.exp === "number" ? p.exp : undefined, name };
	} catch {
		return {};
	}
}

export class Tenants {
	private readonly cores = new Map<string, Core>();
	constructor(private readonly deps: { env: HubEnv; store: HubStore; sealKey: Buffer; log: Logger; now(): number; main: Core; build(env: HubEnv): Promise<Core> }) {}

	private sign(value: string): string {
		return createHmac("sha256", this.deps.env.sessionSecret).update(`tenant:${value}`).digest("base64url");
	}
	cookieValue(id: string, role: TenantRole): string {
		const v = `${id}.${role}`;
		return `${v}.${this.sign(v)}`;
	}
	private parseCookie(raw: string | undefined): { id: string; role: TenantRole } | undefined {
		const m = /^([a-z0-9-]{1,40})\.(admin|client)\.([A-Za-z0-9_-]+)$/.exec(raw ?? "");
		if (!m) return undefined;
		const want = Buffer.from(this.sign(`${m[1]}.${m[2]}`));
		const got = Buffer.from(m[3]!);
		if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
		return this.cores.has(m[1]!) ? { id: m[1]!, role: m[2] as TenantRole } : undefined;
	}
	setCookie(id: string | undefined, role: TenantRole = "client"): string {
		const secure = this.deps.env.publicUrl?.startsWith("https:") ? "; Secure" : "";
		return id ? `${TENANT_COOKIE}=${this.cookieValue(id, role)}; Path=/; Max-Age=${MAX_AGE_SEC}; SameSite=Lax; HttpOnly${secure}` : `${TENANT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`;
	}

	/** Which core serves this request, from the signed cookie. */
	pick(cookieHeader: string | null | undefined): { core: Core; id?: string; role?: TenantRole } {
		const raw = new RegExp(`(?:^|;\\s*)${TENANT_COOKIE}=([^;]+)`).exec(cookieHeader ?? "")?.[1];
		const hit = this.parseCookie(raw);
		return hit ? { core: this.cores.get(hit.id)!, id: hit.id, role: hit.role } : { core: this.deps.main };
	}

	/** A station link finds its own tenant: the join token is looked up in every core. */
	coreOfJoinToken(token: string): { core: Core; id?: string } | undefined {
		const has = (c: Core) => Object.values(c.store.get().stationJoins).some((j) => verifyDeckToken(token, j.tokenHash));
		if (has(this.deps.main)) return { core: this.deps.main };
		for (const [id, core] of this.cores) if (has(core)) return { core, id };
		return undefined;
	}

	private entries(): TenantEntry[] {
		return this.deps.store.get().tenants ?? [];
	}
	private envFor(t: TenantEntry, token: string): HubEnv {
		const base = this.deps.env;
		const host = t.host ?? base.maranics?.host;
		if (!host) throw new Error("no Maranics host: set HUB_MARANICS_HOST or give the tenant its own host");
		const same = !t.host || t.host === base.maranics?.host;
		const who = peekJwt(token).name ?? "token user";
		return {
			...base,
			dataDir: `${base.dataDir}/tenants/${t.id}`,
			oidc: undefined,
			oidcReason: "This tenant uses a pasted access token.",
			devUser: { sub: `dev:${t.id}`, name: who, email: "" },
			devToken: token,
			serviceTokens: [],
			tokenTenant: { id: t.id, name: t.name },
			maranics: {
				host,
				tenant: t.tenant,
				flowsBaseUrl: same && base.maranics ? base.maranics.flowsBaseUrl : `${host}/app/flows`,
				templatesBaseUrl: same && base.maranics ? base.maranics.templatesBaseUrl : `${host}/app/templates`,
				umApiBaseUrl: same && base.maranics ? base.maranics.umApiBaseUrl : `${host}/app/usermanagement`,
				allowedHosts: base.maranics?.allowedHosts ?? [],
			},
		};
	}
	private async boot(t: TenantEntry): Promise<void> {
		const token = openToken(t.tokenEnc, this.deps.sealKey);
		registerSecret(token);
		this.cores.get(t.id)?.stop();
		this.cores.set(t.id, await this.deps.build(this.envFor(t, token)));
		this.deps.log.info(`tenant "${t.name}" (${t.tenant}) running from ${this.deps.env.dataDir}/tenants/${t.id}`);
	}
	async start(): Promise<void> {
		for (const t of this.entries()) {
			try {
				await this.boot(t);
			} catch (err) {
				this.deps.log.warn(`tenant "${t.name}" not started: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	stop(): void {
		for (const c of this.cores.values()) c.stop();
	}

	view(t: TenantEntry): TenantView {
		let exp: number | undefined;
		try {
			exp = peekJwt(openToken(t.tokenEnc, this.deps.sealKey)).exp;
		} catch {
			/* sealed with another HUB_SECRET */
		}
		return { id: t.id, name: t.name, tenant: t.tenant, host: t.host, tokenHint: t.tokenHint, tokenExpiresAt: exp ? new Date(exp * 1000).toISOString() : undefined, createdAt: t.createdAt };
	}

	async add(p: { name: string; tenant: string; token: string; host?: string }): Promise<TenantView> {
		const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "tenant";
		let id = slug;
		for (let n = 2; this.entries().some((t) => t.id === id); n++) id = `${slug}-${n}`;
		const entry: TenantEntry = { id, name: p.name, tenant: p.tenant, host: p.host, tokenEnc: sealToken(p.token, this.deps.sealKey), tokenHint: p.token.slice(-6), createdAt: new Date(this.deps.now()).toISOString() };
		await this.boot(entry); // fails before anything is stored
		await this.deps.store.update((d) => {
			(d.tenants ??= []).push(entry);
		});
		return this.view(entry);
	}
	async replaceToken(id: string, token: string): Promise<TenantView | undefined> {
		const t = this.entries().find((x) => x.id === id);
		if (!t) return undefined;
		const next: TenantEntry = { ...t, tokenEnc: sealToken(token, this.deps.sealKey), tokenHint: token.slice(-6) };
		await this.boot(next);
		await this.deps.store.update((d) => {
			d.tenants = (d.tenants ?? []).map((x) => (x.id === id ? next : x));
		});
		return this.view(next);
	}
	/** Stops the tenant and forgets its token. Its data folder stays on disk. */
	async remove(id: string): Promise<boolean> {
		if (!this.entries().some((x) => x.id === id)) return false;
		this.cores.get(id)?.stop();
		this.cores.delete(id);
		await this.deps.store.update((d) => {
			d.tenants = (d.tenants ?? []).filter((x) => x.id !== id);
		});
		return true;
	}

	/** `/api/tenants…`: always answered by the main hub, whatever tenant the browser is in. */
	app(): Hono {
		const { env, store } = this.deps;
		const app = new Hono();
		const fail = (c: Context, status: 400 | 403 | 404 | 502, code: string, message: string) => c.json({ error: { code, message } }, status);
		const isMainAdmin = async (c: Context): Promise<boolean> => {
			const claims = await readSession(c, env.sessionSecret);
			if (!claims || !validSession(claims, this.deps.now(), store.get().sessionEpoch)) return false;
			const row = store.get().sessions.find((s) => s.sidHash === sidHash(claims.sid));
			return !!row && row.sub === claims.sub && !!store.get().users.find((u) => u.sub === row.sub)?.isAdmin;
		};
		const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
		const secure = env.publicUrl?.startsWith("https:") ? "; Secure" : "";
		const limiter = new RateLimiter(LOGIN_LIMITS, this.deps.now);
		const centralSig = (exp: string) => createHmac("sha256", env.sessionSecret).update(`central:${exp}`).digest("base64url");
		const inCentral = (c: Context): boolean => {
			const m = /^(\d{10,16})\.([A-Za-z0-9_-]+)$/.exec(getCookie(c, CENTRAL_COOKIE) ?? "");
			if (!env.centralPassword || !m || Number(m[1]) < this.deps.now()) return false;
			const want = Buffer.from(centralSig(m[1]!));
			const got = Buffer.from(m[2]!);
			return want.length === got.length && timingSafeEqual(want, got);
		};
		/** With a central password set, only the central area manages tenants; without one, admins of the main hub do. */
		const canManage = async (c: Context): Promise<boolean> => (env.centralPassword ? inCentral(c) : isMainAdmin(c));

		app.get("/api/central/me", (c) => c.json({ configured: !!env.centralPassword, signedIn: inCentral(c), mainName: env.maranics?.tenant ?? "main" }));
		app.post("/api/central/login", async (c) => {
			if (!env.centralPassword) return fail(c, 404, "NOT_CONFIGURED", "the central admin area has no password yet (CENTRAL_PASSWORD)");
			const ip = (env.trustProxy ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined) ?? c.req.header("x-real-ip") ?? "unknown";
			const lim = limiter.check(ip);
			if (!lim.ok) {
				c.header("Retry-After", String(lim.retryAfterSec));
				return c.json({ error: { code: "RATE_LIMITED", message: "too many attempts, wait 15 minutes" } }, 429);
			}
			const given = createHmac("sha256", env.sessionSecret).update(str(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).password) ?? "").digest();
			const want = createHmac("sha256", env.sessionSecret).update(env.centralPassword).digest();
			if (!timingSafeEqual(given, want)) {
				this.deps.log.warn(`central admin: wrong password from ${ip}`);
				return fail(c, 403, "FORBIDDEN", "wrong password");
			}
			const exp = String(this.deps.now() + CENTRAL_TTL_MS);
			c.header("Set-Cookie", `${CENTRAL_COOKIE}=${exp}.${centralSig(exp)}; Path=/; Max-Age=${CENTRAL_TTL_MS / 1000}; SameSite=Strict; HttpOnly${secure}`);
			this.deps.log.info(`central admin: signed in from ${ip}`);
			return c.json({ ok: true });
		});
		app.post("/api/central/logout", (c) => {
			c.header("Set-Cookie", `${CENTRAL_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict; HttpOnly${secure}`);
			return c.json({ ok: true });
		});

		app.get("/api/tenants", async (c) => {
			const cur = this.parseCookie(getCookie(c, TENANT_COOKIE));
			const manage = await canManage(c);
			const curEntry = cur && this.entries().find((t) => t.id === cur.id);
			return c.json<TenantsResponse>({ current: curEntry ? { id: curEntry.id, name: curEntry.name } : undefined, canManage: manage, central: !!env.centralPassword, mainName: env.maranics?.tenant ?? "main", tenants: manage ? this.entries().map((t) => this.view(t)) : [] });
		});
		app.post("/api/tenants/leave", (c) => {
			c.header("Set-Cookie", this.setCookie(undefined));
			return c.json({ ok: true });
		});
		app.use("/api/tenants/*", async (c, next) => ((await canManage(c)) ? next() : fail(c, 403, "FORBIDDEN", env.centralPassword ? "sign in to the central admin area first" : "only an admin of the main hub manages tenants")));
		app.post("/api/tenants", async (c) => {
			if (!(await canManage(c))) return fail(c, 403, "FORBIDDEN", env.centralPassword ? "sign in to the central admin area first" : "only an admin of the main hub manages tenants");
			const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
			const name = str(b.name);
			const tenant = str(b.tenant);
			const token = str(b.token)?.replace(/^Bearer\s+/i, "");
			let host = str(b.host)?.replace(/\/+$/, "");
			if (!name || !tenant || !token) return fail(c, 400, "BAD_REQUEST", "name, tenant and token are required");
			if (host) {
				try {
					const u = new URL(host);
					const allowed = env.maranics?.allowedHosts ?? [];
					if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") throw new Error("https only");
					if (!allowed.some((a) => (a.startsWith(".") ? u.hostname.endsWith(a) : u.hostname === a))) throw new Error(`host not allowed (HUB_ALLOWED_HOSTS): ${u.hostname}`);
					host = u.origin;
				} catch (err) {
					return fail(c, 400, "BAD_REQUEST", `host: ${err instanceof Error ? err.message : "invalid"}`);
				}
			}
			try {
				return c.json(await this.add({ name, tenant, token, host }), 201);
			} catch (err) {
				return fail(c, 502, "TENANT_START", err instanceof Error ? err.message : String(err));
			}
		});
		app.put("/api/tenants/:id/token", async (c) => {
			const token = str(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).token)?.replace(/^Bearer\s+/i, "");
			if (!token) return fail(c, 400, "BAD_REQUEST", "token is required");
			const v = await this.replaceToken(c.req.param("id"), token);
			return v ? c.json(v) : fail(c, 404, "NOT_FOUND", "unknown tenant");
		});
		app.delete("/api/tenants/:id", async (c) => ((await this.remove(c.req.param("id"))) ? c.json({ ok: true }) : fail(c, 404, "NOT_FOUND", "unknown tenant")));
		app.post("/api/tenants/:id/enter", (c) => {
			const id = c.req.param("id");
			if (!this.cores.has(id)) return fail(c, 404, "NOT_FOUND", "unknown tenant");
			c.header("Set-Cookie", this.setCookie(id, "admin"));
			return c.json({ ok: true });
		});
		return app;
	}
}
