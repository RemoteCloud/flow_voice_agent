/**
 * Maranics UserManagement OIDC client (confidential client, authorization code + PKCE, run by the
 * hub). Endpoints come from discovery; the discovered `issuer` must equal the configured one
 * (tenant pin). Signing keys come from `jwks_uri` (cached 5 min, refetched once on an unknown
 * `kid`). Only error bodies of the provider are ever logged, truncated; token responses never.
 *
 * `OidcProvider` is the seam the auth flow and the smoke tests use — `OidcClient` is the real one.
 */
import { fetchJsonFull, HttpError, type FetchLike } from "../core/http.js";
import { registerSecret } from "../core/redact.js";
import type { OidcEnv } from "../env.js";
import type { Logger } from "../core/log.js";
import { checkClaims, decodeJwt, isAllowedAlg, verifySignature, type Jwk, type JwtClaims } from "./jwt.js";

export type OidcErrorCode = "provider_unavailable" | "token_exchange_failed" | "invalid_token" | "userinfo_failed" | "refresh_failed" | "invalid_grant";

export class OidcError extends Error {
	constructor(
		readonly code: OidcErrorCode,
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "OidcError";
	}
}

export interface TokenSet {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	/** Seconds, as reported by the provider (`expires_in`). */
	expiresIn?: number;
	scope?: string;
}

export interface IdClaims extends JwtClaims {
	sub: string;
}

export interface UserInfo {
	sub: string;
	email?: string;
	name?: string;
	positionId?: string;
	positionName?: string;
	/** The Maranics location the sign-in is scoped to (UserManagement claim); flows the user starts land there. */
	locationId?: string;
	locationName?: string;
}

export interface AuthorizeParams {
	state: string;
	nonce: string;
	codeChallenge: string;
	/** Overrides the configured `prompt` for this one sign-in ("login" after a sign-out). */
	prompt?: string;
}

/** What the sign-in flow needs from the identity provider. */
export interface OidcProvider {
	authorizeUrl(p: AuthorizeParams): Promise<string>;
	exchangeCode(code: string, verifier: string): Promise<TokenSet>;
	validateIdToken(idToken: string, nonce?: string): Promise<IdClaims>;
	userinfo(accessToken: string): Promise<UserInfo>;
	refresh(refreshToken: string): Promise<TokenSet>;
	/** `undefined` when logout must stay local (no post-logout URI or no end_session_endpoint). */
	endSessionUrl(idTokenHint?: string): Promise<string | undefined>;
	/** Sign-out: make the token useless at the provider too (RFC 7009). Best effort, never throws. */
	revoke?(token: string, hint: "refresh_token" | "access_token"): Promise<boolean>;
}

export interface DiscoveryDocument {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint: string;
	jwks_uri: string;
	end_session_endpoint?: string;
	revocation_endpoint?: string;
}

export interface OidcClientDeps {
	fetchImpl?: FetchLike;
	now(): number;
	log: Logger;
	/** The bound tenant, cross-checked against a `tenant` claim when the id_token carries one. */
	tenant?: string;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 5 * 60 * 1000;
/** A `kid` miss refetches the JWKS at most this often. */
const JWKS_MISS_REFETCH_MS = 30 * 1000;
const REQUIRED_ENDPOINTS = ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const isHttpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/\S+$/i.test(v);

/** `{error} {error_description}` from an OAuth error body, truncated; never the whole body. */
export function describeOAuthError(bodyText: string | undefined): string {
	if (!bodyText) return "";
	try {
		const v: unknown = JSON.parse(bodyText);
		if (isObj(v)) {
			const parts = [str(v.error), str(v.error_description)].filter((x): x is string => !!x);
			if (parts.length > 0) return parts.join(": ").slice(0, 200);
		}
	} catch {
		/* not JSON */
	}
	return bodyText.replace(/\s+/g, " ").slice(0, 120);
}

export function oauthErrorCode(bodyText: string | undefined): string | undefined {
	if (!bodyText) return undefined;
	try {
		const v: unknown = JSON.parse(bodyText);
		return isObj(v) ? str(v.error) : undefined;
	} catch {
		return undefined;
	}
}

/** Map a userinfo (or id_token) payload onto the fields the hub keeps. */
export function toUserInfo(raw: Record<string, unknown>): UserInfo | undefined {
	const sub = str(raw.sub);
	if (!sub) return undefined;
	const email = (str(raw.email) ?? str(raw.preferred_username))?.toLowerCase();
	const given = str(raw.given_name);
	const family = str(raw.family_name);
	const name = str(raw.name) ?? (given || family ? [given, family].filter(Boolean).join(" ") : undefined) ?? email;
	const positionId = str(raw.position_id) ?? str(raw.positionId);
	const positionName = str(raw.position_name) ?? str(raw.positionName);
	const locationId = str(raw.location_id) ?? str(raw.locationId);
	const locationName = str(raw.location_name) ?? str(raw.locationName) ?? str(raw.location);
	return { sub, email, name, positionId, positionName, locationId, locationName };
}

export class OidcClient implements OidcProvider {
	private discovery?: { at: number; doc: DiscoveryDocument };
	private discoveryPending?: Promise<DiscoveryDocument>;
	private jwks?: { at: number; keys: Jwk[] };
	private jwksPending?: Promise<Jwk[]>;

	constructor(
		private readonly cfg: OidcEnv,
		private readonly deps: OidcClientDeps,
	) {
		registerSecret(cfg.clientSecret);
	}

	get issuer(): string {
		return this.cfg.issuer;
	}

	// ----- discovery -----
	async discover(): Promise<DiscoveryDocument> {
		const now = this.deps.now();
		if (this.discovery && now - this.discovery.at < DISCOVERY_TTL_MS) return this.discovery.doc;
		if (this.discoveryPending) return this.discoveryPending;
		this.discoveryPending = this.fetchDiscovery()
			.then((doc) => {
				this.discovery = { at: this.deps.now(), doc };
				return doc;
			})
			.catch((err: unknown) => {
				if (this.discovery) {
					this.deps.log.warn(`OIDC discovery refresh failed; using the cached document: ${err instanceof Error ? err.message : String(err)}`);
					return this.discovery.doc;
				}
				throw err;
			})
			.finally(() => {
				this.discoveryPending = undefined;
			});
		return this.discoveryPending;
	}

	private async fetchDiscovery(): Promise<DiscoveryDocument> {
		const url = `${this.cfg.issuer}/.well-known/openid-configuration`;
		let body: unknown;
		try {
			body = (await fetchJsonFull<unknown>(url, { headers: { Accept: "application/json" } }, { fetchImpl: this.deps.fetchImpl, timeoutMs: this.cfg.httpTimeoutMs })).body;
		} catch (err) {
			throw new OidcError("provider_unavailable", `OIDC discovery failed (${url}): ${err instanceof HttpError ? `HTTP ${err.status}` : err instanceof Error ? err.message : String(err)}`, err instanceof HttpError ? err.status : undefined);
		}
		if (!isObj(body)) throw new OidcError("provider_unavailable", "OIDC discovery returned no JSON object");
		if (body.issuer !== this.cfg.issuer) throw new OidcError("provider_unavailable", `OIDC discovery issuer mismatch: expected ${this.cfg.issuer}, got ${String(body.issuer).slice(0, 120)}`);
		for (const k of REQUIRED_ENDPOINTS) if (!isHttpUrl(body[k])) throw new OidcError("provider_unavailable", `OIDC discovery document lacks ${k}`);
		const doc: DiscoveryDocument = {
			issuer: body.issuer,
			authorization_endpoint: body.authorization_endpoint as string,
			token_endpoint: body.token_endpoint as string,
			userinfo_endpoint: body.userinfo_endpoint as string,
			jwks_uri: body.jwks_uri as string,
		};
		if (isHttpUrl(body.end_session_endpoint)) doc.end_session_endpoint = body.end_session_endpoint;
		if (isHttpUrl(body.revocation_endpoint)) doc.revocation_endpoint = body.revocation_endpoint;
		return doc;
	}

	// ----- authorize -----
	async authorizeUrl(p: AuthorizeParams): Promise<string> {
		const doc = await this.discover();
		const u = new URL(doc.authorization_endpoint);
		u.searchParams.set("client_id", this.cfg.clientId);
		u.searchParams.set("redirect_uri", this.cfg.redirectUri);
		u.searchParams.set("response_type", "code");
		u.searchParams.set("scope", this.cfg.scopes);
		u.searchParams.set("state", p.state);
		u.searchParams.set("nonce", p.nonce);
		u.searchParams.set("code_challenge", p.codeChallenge);
		u.searchParams.set("code_challenge_method", "S256");
		const prompt = p.prompt ?? this.cfg.prompt;
		if (prompt) u.searchParams.set("prompt", prompt);
		return u.toString();
	}

	// ----- token endpoint -----
	private async postToken(form: Record<string, string>, failCode: "token_exchange_failed" | "refresh_failed"): Promise<TokenSet> {
		const doc = await this.discover();
		const params = new URLSearchParams({ ...form, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret });
		let body: unknown;
		try {
			body = (
				await fetchJsonFull<unknown>(
					doc.token_endpoint,
					{ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: params.toString() },
					{ fetchImpl: this.deps.fetchImpl, timeoutMs: this.cfg.httpTimeoutMs },
				)
			).body;
		} catch (err) {
			if (err instanceof HttpError) {
				const detail = describeOAuthError(err.bodyText);
				const oauth = oauthErrorCode(err.bodyText);
				this.deps.log.warn(`OIDC token endpoint (${form.grant_type}) HTTP ${err.status}${detail ? `: ${detail}` : ""}`);
				if (oauth === "invalid_grant") throw new OidcError("invalid_grant", `${form.grant_type}: ${detail || "invalid_grant"}`, err.status);
				throw new OidcError(failCode, `token endpoint HTTP ${err.status}${detail ? ` (${detail})` : ""}`, err.status);
			}
			throw new OidcError(failCode, `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!isObj(body) || typeof body.access_token !== "string" || !body.access_token) throw new OidcError(failCode, "token response has no access_token");
		const set: TokenSet = { accessToken: body.access_token };
		if (typeof body.refresh_token === "string" && body.refresh_token) set.refreshToken = body.refresh_token;
		if (typeof body.id_token === "string" && body.id_token) set.idToken = body.id_token;
		if (typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0) set.expiresIn = Math.floor(body.expires_in);
		else if (typeof body.expires_in === "string" && /^\d+$/.test(body.expires_in)) set.expiresIn = Number(body.expires_in);
		if (typeof body.scope === "string") set.scope = body.scope;
		registerSecret(set.accessToken);
		registerSecret(set.refreshToken);
		registerSecret(set.idToken);
		return set;
	}

	exchangeCode(code: string, verifier: string): Promise<TokenSet> {
		return this.postToken({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri, code_verifier: verifier }, "token_exchange_failed");
	}

	refresh(refreshToken: string): Promise<TokenSet> {
		return this.postToken({ grant_type: "refresh_token", refresh_token: refreshToken }, "refresh_failed");
	}

	// ----- id_token -----
	private async keys(force: boolean): Promise<Jwk[]> {
		const now = this.deps.now();
		if (!force && this.jwks && now - this.jwks.at < JWKS_TTL_MS) return this.jwks.keys;
		if (this.jwksPending) return this.jwksPending;
		const doc = await this.discover();
		this.jwksPending = fetchJsonFull<unknown>(doc.jwks_uri, { headers: { Accept: "application/json" } }, { fetchImpl: this.deps.fetchImpl, timeoutMs: this.cfg.httpTimeoutMs })
			.then((r) => {
				const keys = isObj(r.body) && Array.isArray(r.body.keys) ? r.body.keys.filter(isObj) : [];
				this.jwks = { at: this.deps.now(), keys: keys as Jwk[] };
				return this.jwks.keys;
			})
			.catch((err: unknown) => {
				if (this.jwks) {
					this.deps.log.warn(`JWKS refresh failed; using the cached keys: ${err instanceof Error ? err.message : String(err)}`);
					return this.jwks.keys;
				}
				throw new OidcError("provider_unavailable", `JWKS fetch failed: ${err instanceof HttpError ? `HTTP ${err.status}` : err instanceof Error ? err.message : String(err)}`);
			})
			.finally(() => {
				this.jwksPending = undefined;
			});
		return this.jwksPending;
	}

	private pick(keys: Jwk[], kid: string | undefined, alg: string): Jwk | undefined {
		const usable = keys.filter((k) => k.kty === "RSA" && (k.use === undefined || k.use === "sig") && (k.alg === undefined || k.alg === alg));
		if (kid !== undefined) return usable.find((k) => k.kid === kid);
		return usable.length === 1 ? usable[0] : undefined;
	}

	async validateIdToken(idToken: string, nonce?: string): Promise<IdClaims> {
		const decoded = decodeJwt(idToken);
		if (!decoded) throw new OidcError("invalid_token", "id_token is malformed or too large");
		const alg = decoded.header.alg;
		if (!isAllowedAlg(alg)) throw new OidcError("invalid_token", `id_token alg ${String(alg).slice(0, 20)} is not accepted`);
		const kid = typeof decoded.header.kid === "string" ? decoded.header.kid : undefined;
		let key = this.pick(await this.keys(false), kid, alg);
		if (!key && (!this.jwks || this.deps.now() - this.jwks.at >= JWKS_MISS_REFETCH_MS)) key = this.pick(await this.keys(true), kid, alg);
		if (!key) throw new OidcError("invalid_token", kid ? `no signing key ${kid.slice(0, 40)} in the JWKS` : "no unique RSA signing key in the JWKS");
		if (!verifySignature(decoded, key)) throw new OidcError("invalid_token", "id_token signature is invalid");
		const problem = checkClaims(decoded.claims, { issuer: this.cfg.issuer, audience: this.cfg.audience, nonce, nowSec: Math.floor(this.deps.now() / 1000), skewSec: this.cfg.clockSkewSec, tenant: this.deps.tenant });
		if (problem) throw new OidcError("invalid_token", `id_token rejected: ${problem}`);
		return decoded.claims as IdClaims;
	}

	// ----- userinfo -----
	async userinfo(accessToken: string): Promise<UserInfo> {
		const doc = await this.discover();
		let body: unknown;
		try {
			body = (await fetchJsonFull<unknown>(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }, { fetchImpl: this.deps.fetchImpl, timeoutMs: this.cfg.httpTimeoutMs })).body;
		} catch (err) {
			const status = err instanceof HttpError ? err.status : undefined;
			const reason = err instanceof HttpError ? (err.wwwAuthenticate ?? err.bodyText?.slice(0, 200)) : undefined;
			throw new OidcError("userinfo_failed", `userinfo ${status ? `HTTP ${status}` : err instanceof Error ? err.message : String(err)}${reason ? ` (${reason})` : ""}`, status);
		}
		if (!isObj(body)) throw new OidcError("userinfo_failed", "userinfo returned no JSON object");
		const info = toUserInfo(body);
		if (!info) throw new OidcError("userinfo_failed", "userinfo has no sub");
		return info;
	}

	// ----- logout -----
	async revoke(token: string, hint: "refresh_token" | "access_token"): Promise<boolean> {
		try {
			const doc = await this.discover();
			if (!doc.revocation_endpoint) return false;
			const params = new URLSearchParams({ token, token_type_hint: hint, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret });
			const res = await (this.deps.fetchImpl ?? fetch)(doc.revocation_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString(), signal: AbortSignal.timeout(this.cfg.httpTimeoutMs) });
			if (!res.ok) this.deps.log.warn(`OIDC revocation (${hint}) HTTP ${res.status}`);
			return res.ok;
		} catch (err) {
			this.deps.log.warn(`OIDC revocation (${hint}) failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async endSessionUrl(idTokenHint?: string): Promise<string | undefined> {
		if (!this.cfg.postLogoutRedirectUri) return undefined;
		let doc: DiscoveryDocument;
		try {
			doc = await this.discover();
		} catch {
			return undefined;
		}
		if (!doc.end_session_endpoint) return undefined;
		const u = new URL(doc.end_session_endpoint);
		u.searchParams.set("post_logout_redirect_uri", this.cfg.postLogoutRedirectUri);
		u.searchParams.set("client_id", this.cfg.clientId);
		if (idTokenHint) u.searchParams.set("id_token_hint", idTokenHint);
		return u.toString();
	}
}
