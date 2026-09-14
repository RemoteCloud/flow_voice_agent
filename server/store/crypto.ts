/** Token sealing (AES-256-GCM under an HKDF-derived key), deck tokens and hashes. node:crypto only. */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { DECK_TOKEN_PREFIX, JOIN_TOKEN_PREFIX } from "../protocol.js";

const SEAL_VERSION = "v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

/** 32-byte key from `HUB_SECRET`: HKDF-SHA256, salt `flowdeck-hub`, info `token-v1`. */
export function deriveKey(secret: string): Buffer {
	return Buffer.from(hkdfSync("sha256", secret, "flowdeck-hub", "token-v1", 32));
}

/** `v1:` + base64url(iv | tag | ciphertext). */
export function sealToken(plain: string, key: Buffer): string {
	const iv = randomBytes(IV_LEN);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return SEAL_VERSION + Buffer.concat([iv, tag, ct]).toString("base64url");
}

/** Inverse of `sealToken`; throws on a bad version, truncation, wrong key or tampering. */
export function openToken(sealed: string, key: Buffer): string {
	if (!sealed.startsWith(SEAL_VERSION)) throw new Error("unsupported sealed token version");
	const buf = Buffer.from(sealed.slice(SEAL_VERSION.length), "base64url");
	if (buf.length < IV_LEN + TAG_LEN) throw new Error("sealed token too short");
	const iv = buf.subarray(0, IV_LEN);
	const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
	const ct = buf.subarray(IV_LEN + TAG_LEN);
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** `fdk_` + 32 random bytes (base64url); satisfies `isDeckToken`. */
export function newDeckToken(): string {
	return DECK_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** `fvj_` + 32 random bytes (base64url): a station QR join token; hashed with `hashDeckToken`. */
export function newJoinToken(): string {
	return JOIN_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashDeckToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time check of a presented deck token against a stored sha256 hex hash. */
export function verifyDeckToken(token: string, tokenHash: string): boolean {
	return constantTimeEqual(hashDeckToken(token), tokenHash);
}

/** Constant-time string comparison (compares sha256 digests, so lengths do not leak). */
export function constantTimeEqual(a: string, b: string): boolean {
	const da = createHash("sha256").update(a, "utf8").digest();
	const db = createHash("sha256").update(b, "utf8").digest();
	return timingSafeEqual(da, db);
}

/** Last 4 characters, for display. */
export function tokenHint(token: string): string {
	const t = token.trim();
	return t.slice(-4);
}

/** ISO `exp` of a JWT bearer token, `undefined` for opaque tokens. Never throws. */
export function jwtExp(token: string): string | undefined {
	try {
		const parts = token.trim().split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
		if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return undefined;
		return new Date(payload.exp * 1000).toISOString();
	} catch {
		return undefined;
	}
}

/** Short random id for decks (`d_` + 8 hex). */
export function newDeckId(): string {
	return `d_${randomBytes(4).toString("hex")}`;
}
