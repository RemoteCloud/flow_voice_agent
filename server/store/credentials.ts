/**
 * Per-session Maranics credentials: the sealed tokens live on the `HubSession` row; this holder
 * unseals them, refreshes an expiring access token through the OIDC provider, and yields the
 * `ApiSettings` the Flows client needs. One user = one token = one audit identity.
 */
import type { MaranicsEnv } from "../env.js";
import type { Logger } from "../core/log.js";
import type { ApiSettings } from "../maranics/FlowsClient.js";
import type { OidcProvider } from "../oidc/OidcClient.js";
import { openToken, sealToken } from "./crypto.js";
import type { HubCredential, HubSession, HubStore } from "./HubStore.js";

const REFRESH_BEFORE_MS = 90_000;

export interface CredentialsDeps {
	store: HubStore;
	sealKey: Buffer;
	provider?: OidcProvider;
	maranics?: MaranicsEnv;
	now(): number;
	log: Logger;
	/** Dev mode: a static bearer for every session (no OIDC). */
	devToken?: string;
}

export class Credentials {
	private readonly refreshing = new Map<string, Promise<HubCredential | undefined>>();
	constructor(private readonly deps: CredentialsDeps) {}

	/** Access token for the session, refreshed if it expires within 90 s. `undefined` = sign in again. */
	async accessToken(session: HubSession): Promise<string | undefined> {
		if (this.deps.devToken && session.sub.startsWith("dev:")) return this.deps.devToken;
		const cred = session.credential;
		if (!cred) return undefined;
		const exp = Date.parse(cred.accessExp);
		if (Number.isFinite(exp) && exp - this.deps.now() > REFRESH_BEFORE_MS && cred.state === "ok") return this.open(cred.accessTokenEnc);
		const refreshed = await this.refresh(session);
		return refreshed ? this.open(refreshed.accessTokenEnc) : undefined;
	}

	async apiSettings(session: HubSession): Promise<ApiSettings | undefined> {
		const m = this.deps.maranics;
		if (!m) return undefined;
		const token = await this.accessToken(session);
		if (!token) return undefined;
		return { flowsBaseUrl: m.flowsBaseUrl, templatesBaseUrl: m.templatesBaseUrl, tenant: m.tenant, bearerToken: token };
	}

	idToken(session: HubSession): string | undefined {
		return session.credential?.idTokenEnc ? this.open(session.credential.idTokenEnc) : undefined;
	}

	/** The session's own tokens, for revoking them at sign-out. Never the shared dev / tenant token. */
	tokensOf(session: HubSession): { refreshToken?: string; accessToken?: string } {
		const cred = session.credential;
		if (!cred) return {};
		return { refreshToken: cred.refreshTokenEnc ? this.open(cred.refreshTokenEnc) : undefined, accessToken: this.open(cred.accessTokenEnc) };
	}

	private open(sealed: string): string | undefined {
		try {
			return openToken(sealed, this.deps.sealKey);
		} catch {
			return undefined;
		}
	}

	private refresh(session: HubSession): Promise<HubCredential | undefined> {
		const inflight = this.refreshing.get(session.id);
		if (inflight) return inflight;
		const p = this.doRefresh(session).finally(() => this.refreshing.delete(session.id));
		this.refreshing.set(session.id, p);
		return p;
	}

	private async doRefresh(session: HubSession): Promise<HubCredential | undefined> {
		const cred = session.credential;
		if (!cred) return undefined;
		const rt = cred.refreshTokenEnc ? this.open(cred.refreshTokenEnc) : undefined;
		if (!rt || !this.deps.provider) {
			const exp = Date.parse(cred.accessExp);
			if (Number.isFinite(exp) && exp > this.deps.now()) return cred; // still usable, just close to expiry
			await this.deps.store.update((d) => {
				const s = d.sessions.find((x) => x.id === session.id);
				if (s?.credential) s.credential.state = "expired";
			});
			return undefined;
		}
		try {
			const tokens = await this.deps.provider.refresh(rt);
			const now = this.deps.now();
			const next: HubCredential = {
				...cred,
				accessTokenEnc: sealToken(tokens.accessToken, this.deps.sealKey),
				refreshTokenEnc: tokens.refreshToken ? sealToken(tokens.refreshToken, this.deps.sealKey) : cred.refreshTokenEnc,
				idTokenEnc: tokens.idToken ? sealToken(tokens.idToken, this.deps.sealKey) : cred.idTokenEnc,
				accessExp: new Date(now + (tokens.expiresIn ?? 3600) * 1000).toISOString(),
				obtainedAt: new Date(now).toISOString(),
				state: "ok",
				lastError: undefined,
			};
			await this.deps.store.update((d) => {
				const s = d.sessions.find((x) => x.id === session.id);
				if (s) s.credential = next;
			});
			session.credential = next;
			this.deps.log.debug(`token refreshed for ${cred.sub}`);
			return next;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.deps.log.warn(`token refresh failed for ${cred.sub}: ${message}`);
			await this.deps.store.update((d) => {
				const s = d.sessions.find((x) => x.id === session.id);
				if (s?.credential) {
					s.credential.state = "refresh_failed";
					s.credential.lastError = message;
				}
			});
			const exp = Date.parse(cred.accessExp);
			return Number.isFinite(exp) && exp > this.deps.now() ? cred : undefined;
		}
	}
}
