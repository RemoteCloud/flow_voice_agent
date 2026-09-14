/**
 * Operator session = signed `fd_session` cookie (hono `setSignedCookie`, `SESSION_SECRET`) whose
 * payload is base64url JSON `{v: 2, sid, sub, tenant, iat, exp, epoch}`, plus a server-side row
 * (`HubSession`, keyed by `sha256(sid)`) that logout / revocation / access loss can delete.
 * 12 h sliding (re-issued when less than 6 h remain), 7 d absolute; `epoch` must equal the store's
 * `sessionEpoch`. The login flow uses a second, short-lived signed cookie (`fd_login`) that binds
 * the browser to the OIDC `state` + `nonce`.
 */
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { createHash, randomBytes } from "node:crypto";
import type { HubSession } from "../store/HubStore.js";

export const SESSION_COOKIE = "fd_session";
export const LOGIN_COOKIE = "fd_login";
export const LOGIN_COOKIE_PATH = "/api/auth";
/** Station QR join: set by `POST /api/auth/join` before sign-in, consumed by the callback / dev login. */
export const JOIN_COOKIE = "fv_join";
export const JOIN_COOKIE_PATH = LOGIN_COOKIE_PATH;
export const JOIN_MAX_AGE_SEC = 15 * 60;
export const SLIDING_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const RENEW_BELOW_MS = 6 * 60 * 60 * 1000;
/** `lastSeenAt` is written at most this often per session. */
export const LAST_SEEN_WRITE_MS = 60_000;
/** Tolerated clock skew for `iat` in the future. */
const SKEW_MS = 60_000;

export interface SessionClaims {
	v: 2;
	/** Secret session id; the store holds `sha256(sid)`. */
	sid: string;
	/** UserManagement subject of the signed-in user. */
	sub: string;
	tenant: string;
	/** ms since epoch, first issue (absolute limit counts from here). */
	iat: number;
	/** ms since epoch. */
	exp: number;
	epoch: number;
}

export interface LoginCookie {
	state: string;
	nonce: string;
	/** ms since epoch. */
	iat: number;
}

export interface JoinCookie {
	stationId: string;
	/** ms since epoch. */
	iat: number;
}

export type SessionEnv = { Variables: { session: SessionClaims; sessionRow: HubSession } };

export function newSid(rand: (n: number) => Buffer = randomBytes): string {
	return rand(32).toString("base64url");
}

export function sidHash(sid: string): string {
	return createHash("sha256").update(sid, "utf8").digest("hex");
}

/** Display id for a session row (`s_` + 8 hex); never derived from the sid. */
export function newSessionId(rand: (n: number) => Buffer = randomBytes): string {
	return `s_${rand(4).toString("hex")}`;
}

export function newSession(p: { sid: string; sub: string; tenant: string; epoch: number; nowMs: number }): SessionClaims {
	return { v: 2, sid: p.sid, sub: p.sub, tenant: p.tenant, iat: p.nowMs, exp: p.nowMs + SLIDING_MS, epoch: p.epoch };
}

export function encodeSession(claims: SessionClaims): string {
	return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

export function decodeSession(text: string): SessionClaims | undefined {
	try {
		const v = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<SessionClaims>;
		if (!v || typeof v !== "object") return undefined;
		if (v.v !== 2 || typeof v.sid !== "string" || !v.sid || typeof v.sub !== "string" || !v.sub || typeof v.tenant !== "string" || typeof v.iat !== "number" || typeof v.exp !== "number" || typeof v.epoch !== "number") return undefined;
		return { v: 2, sid: v.sid, sub: v.sub, tenant: v.tenant, iat: v.iat, exp: v.exp, epoch: v.epoch };
	} catch {
		return undefined;
	}
}

export function validSession(claims: SessionClaims, nowMs: number, epoch: number): boolean {
	if (claims.v !== 2 || claims.epoch !== epoch) return false;
	if (claims.iat > nowMs + SKEW_MS) return false;
	if (claims.exp <= nowMs) return false;
	if (claims.iat + ABSOLUTE_MS <= nowMs) return false;
	return true;
}

export function shouldRenew(claims: SessionClaims, nowMs: number): boolean {
	return claims.exp - nowMs < RENEW_BELOW_MS;
}

/** Slide `exp` forward, never past the absolute limit. */
export function renewSession(claims: SessionClaims, nowMs: number): SessionClaims {
	return { ...claims, exp: Math.min(nowMs + SLIDING_MS, claims.iat + ABSOLUTE_MS) };
}

export function cookieOptions(secure: boolean): CookieOptions {
	return { httpOnly: true, sameSite: "Lax", path: "/", secure, maxAge: Math.floor(ABSOLUTE_MS / 1000) };
}

export async function readSession(c: Context, secret: string): Promise<SessionClaims | undefined> {
	const v = await getSignedCookie(c, secret, SESSION_COOKIE);
	if (!v) return undefined;
	return decodeSession(v);
}

export async function writeSession(c: Context, claims: SessionClaims, secret: string, secure: boolean): Promise<void> {
	await setSignedCookie(c, SESSION_COOKIE, encodeSession(claims), secret, cookieOptions(secure));
}

export function clearSession(c: Context, secure: boolean): void {
	deleteCookie(c, SESSION_COOKIE, { path: "/", secure });
}

// ----- login-flow cookie -----

export function encodeLoginCookie(v: LoginCookie): string {
	return Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
}

export function decodeLoginCookie(text: string): LoginCookie | undefined {
	try {
		const v = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<LoginCookie>;
		if (!v || typeof v !== "object" || typeof v.state !== "string" || !v.state || typeof v.nonce !== "string" || !v.nonce || typeof v.iat !== "number") return undefined;
		return { state: v.state, nonce: v.nonce, iat: v.iat };
	} catch {
		return undefined;
	}
}

export async function writeLoginCookie(c: Context, v: LoginCookie, secret: string, secure: boolean, maxAgeSec: number): Promise<void> {
	await setSignedCookie(c, LOGIN_COOKIE, encodeLoginCookie(v), secret, { httpOnly: true, sameSite: "Lax", path: LOGIN_COOKIE_PATH, secure, maxAge: maxAgeSec });
}

export async function readLoginCookie(c: Context, secret: string): Promise<LoginCookie | undefined> {
	const v = await getSignedCookie(c, secret, LOGIN_COOKIE);
	if (!v) return undefined;
	return decodeLoginCookie(v);
}

export function clearLoginCookie(c: Context, secure: boolean): void {
	deleteCookie(c, LOGIN_COOKIE, { path: LOGIN_COOKIE_PATH, secure });
}

// ----- station join cookie -----

export function encodeJoinCookie(v: JoinCookie): string {
	return Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
}

export function decodeJoinCookie(text: string): JoinCookie | undefined {
	try {
		const v = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<JoinCookie>;
		if (!v || typeof v !== "object" || typeof v.stationId !== "string" || !v.stationId || typeof v.iat !== "number") return undefined;
		return { stationId: v.stationId, iat: v.iat };
	} catch {
		return undefined;
	}
}

export async function writeJoinCookie(c: Context, v: JoinCookie, secret: string, secure: boolean): Promise<void> {
	await setSignedCookie(c, JOIN_COOKIE, encodeJoinCookie(v), secret, { httpOnly: true, sameSite: "Lax", path: JOIN_COOKIE_PATH, secure, maxAge: JOIN_MAX_AGE_SEC });
}

export async function readJoinCookie(c: Context, secret: string): Promise<JoinCookie | undefined> {
	const v = await getSignedCookie(c, secret, JOIN_COOKIE);
	if (!v) return undefined;
	return decodeJoinCookie(v);
}

export function clearJoinCookie(c: Context, secure: boolean): void {
	deleteCookie(c, JOIN_COOKIE, { path: JOIN_COOKIE_PATH, secure });
}

// ----- middleware -----

export interface SessionDeps {
	secret: string;
	secure: boolean;
	epoch(): number;
	now(): number;
	/** The live row for this cookie (`undefined` = logged out, revoked or no longer allowed). */
	lookup(sidHash: string): HubSession | undefined;
	/** Called on every authenticated request; the implementation throttles the write. */
	touch?(row: HubSession, nowMs: number): void;
}

/** 401 `{error, code: "UNAUTHORIZED"}` without a valid session; otherwise `session` + `sessionRow` are set. */
export function requireSession(deps: SessionDeps): MiddlewareHandler<SessionEnv> {
	return async (c, next) => {
		const claims = await readSession(c, deps.secret);
		const now = deps.now();
		const row = claims && validSession(claims, now, deps.epoch()) ? deps.lookup(sidHash(claims.sid)) : undefined;
		if (!claims || !row || row.sub !== claims.sub) return c.json({ error: "login required", code: "UNAUTHORIZED" }, 401);
		let current = claims;
		if (shouldRenew(claims, now)) {
			current = renewSession(claims, now);
			await writeSession(c, current, deps.secret, deps.secure);
		}
		deps.touch?.(row, now);
		c.set("session", current);
		c.set("sessionRow", row);
		await next();
	};
}
