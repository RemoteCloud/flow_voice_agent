/** PKCE (RFC 7636, S256) + random state/nonce/session ids. node:crypto only. */
import { createHash, randomBytes } from "node:crypto";

export type RandomBytes = (n: number) => Buffer;

/** URL-safe random token of `bytes` entropy (base64url, no padding). */
export function randomToken(bytes = 32, rand: RandomBytes = randomBytes): string {
	return rand(bytes).toString("base64url");
}

/** `BASE64URL(SHA256(verifier))` — the `code_challenge` for `code_challenge_method=S256`. */
export function codeChallenge(verifier: string): string {
	return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** A fresh verifier (64 URL-safe chars; RFC 7636 allows 43..128) and its S256 challenge. */
export function pkcePair(rand: RandomBytes = randomBytes): { verifier: string; challenge: string } {
	const verifier = randomToken(48, rand);
	return { verifier, challenge: codeChallenge(verifier) };
}
