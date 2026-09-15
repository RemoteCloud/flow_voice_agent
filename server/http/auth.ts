/**
 * Sign-in brokered by the hub against Maranics UserManagement (OIDC authorization code + PKCE),
 * ported from the FlowDeck hub with one change: the tokens are sealed on the *session* row, so
 * every device / browser acts on Maranics as its own signed-in user and every value written to
 * Flow is attributed to the person who answered (spec 11, 12.4).
 *
 * Dev mode (`DEV_USER`): `POST /api/auth/dev` mints a session without a provider.
 */
import type { OidcEnv } from "../env.js";
import type { Logger } from "../core/log.js";
import { OidcError, toUserInfo, type OidcProvider, type TokenSet, type UserInfo } from "../oidc/OidcClient.js";
import { pkcePair, randomToken, type RandomBytes } from "../oidc/pkce.js";
import { constantTimeEqual, sealToken } from "../store/crypto.js";
import type { HubCredential, HubSession, HubStore, HubUser } from "../store/HubStore.js";
import { ABSOLUTE_MS, newSessionId, newSid, sidHash, type LoginCookie } from "./session.js";

export type AuthErrorCode = "provider_unavailable" | "invalid_state" | "expired_state" | "token_exchange_failed" | "invalid_token" | "userinfo_failed" | "not_allowed" | "rate_limited" | "not_configured";

export interface AuthProviderView {
	kind: "oidc" | "dev";
	configured: boolean;
	tenant?: string;
	issuerHost?: string;
	reason?: string;
	devUserName?: string;
}

export const DEFAULT_ACCESS_TTL_SEC = 3600;
const MAX_FLOWS = 1000;

interface LoginFlow {
	state: string;
	nonce: string;
	verifier: string;
	createdAt: number;
	/** Where the browser goes after the callback (the PWA route, or the Android app's custom scheme). */
	returnTo?: string;
}

export type LoginStart = { ok: true; redirectUrl: string; cookie: LoginCookie } | { ok: false; code: AuthErrorCode; detail: string };
export type LoginOutcome = { ok: true; sid: string; session: HubSession; user: HubUser; returnTo?: string } | { ok: false; code: AuthErrorCode; detail: string; returnTo?: string };

export interface OidcAuthDeps {
	store: HubStore;
	provider?: OidcProvider;
	oidc?: OidcEnv;
	tenant?: string;
	sealKey: Buffer;
	now(): number;
	log: Logger;
	rand?: RandomBytes;
	unconfiguredReason?: string;
	devUser?: { sub: string; name: string; email: string };
	/** Position ids allowed to sign in; empty = everyone in the tenant. */
	allowedPositionIds?: string[];
}

const iso = (ms: number) => new Date(ms).toISOString();

export function providerErrorCode(error: string): AuthErrorCode {
	return error === "server_error" || error === "temporarily_unavailable" ? "provider_unavailable" : "token_exchange_failed";
}

export function buildCredential(info: UserInfo, tokens: TokenSet, sealKey: Buffer, nowMs: number): HubCredential {
	const cred: HubCredential = {
		sub: info.sub,
		accessTokenEnc: sealToken(tokens.accessToken, sealKey),
		accessExp: iso(nowMs + (tokens.expiresIn ?? DEFAULT_ACCESS_TTL_SEC) * 1000),
		obtainedAt: iso(nowMs),
		state: "ok",
	};
	if (tokens.refreshToken) cred.refreshTokenEnc = sealToken(tokens.refreshToken, sealKey);
	if (tokens.idToken) cred.idTokenEnc = sealToken(tokens.idToken, sealKey);
	return cred;
}

export class OidcAuth {
	private readonly flows = new Map<string, LoginFlow>();
	private readonly rand: RandomBytes | undefined;

	constructor(private readonly deps: OidcAuthDeps) {
		this.rand = deps.rand;
	}

	get configured(): boolean {
		return !!(this.deps.provider && this.deps.oidc);
	}

	providerView(): AuthProviderView {
		if (!this.configured && this.deps.devUser) return { kind: "dev", configured: true, tenant: this.deps.tenant, devUserName: this.deps.devUser.name };
		const v: AuthProviderView = { kind: "oidc", configured: this.configured, tenant: this.deps.tenant };
		if (this.deps.oidc) {
			try {
				v.issuerHost = new URL(this.deps.oidc.issuer).hostname;
			} catch {
				/* unparseable issuer */
			}
		} else v.reason = this.deps.unconfiguredReason ?? "Sign-in is not configured on this hub (HUB_OIDC_* environment)";
		if (this.deps.devUser) v.devUserName = this.deps.devUser.name;
		return v;
	}

	sweepFlows(): void {
		const maxAge = (this.deps.oidc?.flowMaxAgeSec ?? 600) * 1000;
		const now = this.deps.now();
		for (const [k, f] of this.flows) if (now - f.createdAt > maxAge) this.flows.delete(k);
		while (this.flows.size > MAX_FLOWS) {
			const oldest = this.flows.keys().next().value;
			if (oldest === undefined) break;
			this.flows.delete(oldest);
		}
	}

	async startLogin(returnTo?: string): Promise<LoginStart> {
		if (!this.deps.provider || !this.deps.oidc) return { ok: false, code: "not_configured", detail: "HUB_OIDC_* is not set" };
		this.sweepFlows();
		const state = randomToken(32, this.rand);
		const nonce = randomToken(32, this.rand);
		const { verifier, challenge } = pkcePair(this.rand);
		let redirectUrl: string;
		try {
			redirectUrl = await this.deps.provider.authorizeUrl({ state, nonce, codeChallenge: challenge });
		} catch (err) {
			this.deps.log.warn(`login cannot start: ${err instanceof Error ? err.message : String(err)}`);
			return { ok: false, code: "provider_unavailable", detail: err instanceof Error ? err.message : String(err) };
		}
		const now = this.deps.now();
		this.flows.set(state, { state, nonce, verifier, createdAt: now, returnTo });
		return { ok: true, redirectUrl, cookie: { state, nonce, iat: now } };
	}

	async completeLogin(query: Record<string, string | undefined>, cookie: LoginCookie | undefined, ip: string): Promise<LoginOutcome> {
		const state = query.state ?? "";
		const flow = state ? this.flows.get(state) : undefined;
		const failed = (code: AuthErrorCode, detail: string): LoginOutcome => {
			this.deps.log.warn(`login from ${ip} failed (${code}): ${detail}`);
			return { ok: false, code, detail, returnTo: flow?.returnTo };
		};
		if (!this.deps.provider || !this.deps.oidc) return failed("not_configured", "HUB_OIDC_* is not set");
		if (!cookie) return failed("invalid_state", "no login cookie (the login was started in another browser, or the cookie expired)");
		if (!state || !constantTimeEqual(state, cookie.state)) return failed("invalid_state", "state does not match the login cookie");
		this.flows.delete(state);
		if (!flow) return failed("invalid_state", "unknown or already redeemed login flow");
		if (!constantTimeEqual(flow.nonce, cookie.nonce)) return failed("invalid_state", "nonce does not match the login cookie");
		const now = this.deps.now();
		if (now - flow.createdAt > this.deps.oidc.flowMaxAgeSec * 1000) return failed("expired_state", `login took longer than ${this.deps.oidc.flowMaxAgeSec} s`);
		if (query.error) return failed(providerErrorCode(query.error), `provider answered ${query.error}${query.error_description ? `: ${query.error_description.slice(0, 200)}` : ""}`);
		const code = query.code ?? "";
		if (!code) return failed("token_exchange_failed", "callback without a code");

		let tokens: TokenSet;
		try {
			tokens = await this.deps.provider.exchangeCode(code, flow.verifier);
		} catch (err) {
			return failed("token_exchange_failed", err instanceof Error ? err.message : String(err));
		}
		if (!tokens.idToken) return failed("invalid_token", "token response has no id_token (is the openid scope granted?)");
		let sub: string;
		let idInfo: UserInfo | undefined;
		try {
			const claims = await this.deps.provider.validateIdToken(tokens.idToken, flow.nonce);
			sub = claims.sub;
			idInfo = toUserInfo(claims);
		} catch (err) {
			return failed("invalid_token", err instanceof Error ? err.message : String(err));
		}
		const idEmail = idInfo?.email;
		const idName = idInfo?.name;
		let info: UserInfo;
		try {
			info = await this.deps.provider.userinfo(tokens.accessToken);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			const refused = err instanceof OidcError && (err.status === 401 || err.status === 403);
			// UserManagement sometimes refuses userinfo (HTTP 403) for a token it just issued. The id_token is
			// already verified (signature, issuer, audience, nonce, tenant), so its claims identify the user.
			if (!refused || !idInfo) return failed("userinfo_failed", detail);
			this.deps.log.warn(`login from ${ip}: ${detail}; using the verified id_token claims`);
			info = idInfo;
		}
		if (!constantTimeEqual(info.sub, sub)) return failed("userinfo_failed", "userinfo sub differs from the id_token sub");
		info = { ...info, email: info.email ?? idEmail, name: info.name ?? idName ?? info.email ?? idEmail };
		const allowed = this.deps.allowedPositionIds ?? [];
		if (allowed.length && !(info.positionId && allowed.includes(info.positionId.toLowerCase()))) return failed("not_allowed", `user ${sub} (position ${info.positionName ?? info.positionId ?? "none"}) is not in an allowed position`);

		const cred = buildCredential(info, tokens, this.deps.sealKey, now);
		const out = await this.provision(info, cred, ip);
		this.deps.log.info(`login from ${ip}: ${info.email ?? sub}${info.positionName ? ` (${info.positionName})` : ""}${tokens.refreshToken ? "" : " (no refresh token — access ends when the token expires)"}`);
		return { ...out, returnTo: flow.returnTo };
	}

	/** Dev sign-in: no provider, no tokens (the Flows client uses DEV_MARANICS_TOKEN or the fake Maranics static token). */
	async devLogin(ip: string): Promise<LoginOutcome> {
		const u = this.deps.devUser;
		if (!u) return { ok: false, code: "not_configured", detail: "DEV_USER is not set" };
		const out = await this.provision({ sub: u.sub, email: u.email, name: u.name }, undefined, ip);
		this.deps.log.info(`dev login from ${ip}: ${u.name}`);
		return out;
	}

	private async provision(info: UserInfo, cred: HubCredential | undefined, _ip: string): Promise<Extract<LoginOutcome, { ok: true }>> {
		const now = this.deps.now();
		const nowIso = iso(now);
		const sid = newSid(this.rand);
		const row: HubSession = { id: newSessionId(this.rand), sidHash: sidHash(sid), sub: info.sub, createdAt: nowIso, lastSeenAt: nowIso, credential: cred };
		let user: HubUser | undefined;
		await this.deps.store.update((d) => {
			let u = d.users.find((x) => x.sub === info.sub);
			if (!u) {
				u = { sub: info.sub, isAdmin: d.users.length === 0, firstSeenAt: nowIso, lastLoginAt: nowIso, logins: 0 };
				d.users.push(u);
			}
			u.email = info.email;
			u.name = info.name;
			u.positionId = info.positionId;
			u.positionName = info.positionName;
			u.lastLoginAt = nowIso;
			u.logins += 1;
			user = { ...u };
			// many sessions per user are fine (phone + bridge tablet); sweep rows past the absolute limit
			d.sessions = d.sessions.filter((s) => Date.parse(s.createdAt) + ABSOLUTE_MS > now);
			d.sessions.push(row);
		});
		return { ok: true, sid, session: row, user: user as HubUser };
	}

	async logout(row: HubSession | undefined, idTokenHint?: string): Promise<{ endSessionUrl: string }> {
		if (row) {
			await this.deps.store.update((d) => {
				d.sessions = d.sessions.filter((s) => s.id !== row.id);
			});
		}
		let endSessionUrl: string | undefined;
		if (this.deps.provider && row) {
			try {
				endSessionUrl = await this.deps.provider.endSessionUrl(idTokenHint);
			} catch {
				endSessionUrl = undefined;
			}
		}
		return { endSessionUrl: endSessionUrl ?? "/" };
	}

	async revokeSession(id: string): Promise<boolean> {
		if (!this.deps.store.get().sessions.some((s) => s.id === id)) return false;
		await this.deps.store.update((d) => {
			d.sessions = d.sessions.filter((s) => s.id !== id);
		});
		return true;
	}
}
