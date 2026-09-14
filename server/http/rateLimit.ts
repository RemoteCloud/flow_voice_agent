/** Sliding-window rate limiter with an injected clock. Pure. */

export interface RateLimitOptions {
	windowMs: number;
	/** Attempts per key (IP) per window. */
	perKey: number;
	/** Attempts across all keys per window. */
	global: number;
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

/** `GET /api/hub/auth/login` starts (an OIDC redirect is cheap for the hub, so looser than a password form). */
export const LOGIN_LIMITS: RateLimitOptions = { windowMs: 15 * 60 * 1000, perKey: 20, global: 100 };
/** `POST /api/auth/join`: a poster is scanned by many phones behind one NAT; the 256-bit token makes this about noise, not brute force. */
export const JOIN_LIMITS: RateLimitOptions = { windowMs: 15 * 60 * 1000, perKey: 30, global: 300 };

export class RateLimiter {
	private readonly perKey = new Map<string, number[]>();
	private all: number[] = [];

	constructor(
		private readonly opts: RateLimitOptions,
		private readonly now: () => number,
	) {}

	/** Records the attempt when allowed. */
	check(key: string): RateLimitResult {
		const now = this.now();
		const since = now - this.opts.windowMs;
		this.all = this.all.filter((t) => t > since);
		const mine = (this.perKey.get(key) ?? []).filter((t) => t > since);
		if (mine.length === 0) this.perKey.delete(key);
		else this.perKey.set(key, mine);
		for (const [k, list] of this.perKey) if (!list.some((t) => t > since)) this.perKey.delete(k);
		if (mine.length >= this.opts.perKey) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((mine[0] + this.opts.windowMs - now) / 1000)) };
		if (this.all.length >= this.opts.global) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((this.all[0] + this.opts.windowMs - now) / 1000)) };
		mine.push(now);
		this.perKey.set(key, mine);
		this.all.push(now);
		return { ok: true };
	}

	reset(): void {
		this.perKey.clear();
		this.all = [];
	}
}
