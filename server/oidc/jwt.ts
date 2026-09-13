/**
 * Compact JWS decoding, RSA signature verification against a JWK and the id_token claim checks
 * (issuer, audience, expiry, issue time, nonce, tenant). node:crypto only, no JOSE library.
 *
 * Deliberately narrow: only the RSA algorithms UserManagement (OpenIddict) can sign with are
 * accepted — `RS256/384/512` and `PS256/384/512`. `none`, HMAC and EC are rejected outright, so
 * an attacker cannot downgrade the check to a shared secret or an unsigned token.
 */
import { constants, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { constantTimeEqual } from "../store/crypto.js";

export const ALLOWED_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512"] as const;
export type JwtAlg = (typeof ALLOWED_ALGS)[number];
/** Larger tokens are refused before any parsing (a JWT is a few hundred bytes). */
export const MAX_JWT_BYTES = 16 * 1024;

export interface JwtHeader {
	alg?: string;
	kid?: string;
	typ?: string;
	[k: string]: unknown;
}

export interface JwtClaims {
	iss?: string;
	sub?: string;
	aud?: string | string[];
	exp?: number;
	iat?: number;
	nbf?: number;
	nonce?: string;
	email?: string;
	name?: string;
	tenant?: string;
	[k: string]: unknown;
}

export interface DecodedJwt {
	header: JwtHeader;
	claims: JwtClaims;
	/** `<b64 header>.<b64 payload>` — what the signature covers. */
	signingInput: string;
	signature: Buffer;
}

/** A JSON Web Key as published on `jwks_uri` (only RSA public keys are usable here). */
export interface Jwk {
	kty?: string;
	kid?: string;
	alg?: string;
	use?: string;
	n?: string;
	e?: string;
	[k: string]: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function b64json(part: string): Record<string, unknown> | undefined {
	try {
		const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
		return isObj(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

/** Split + base64url-decode without verifying anything. `undefined` for anything malformed or oversized. */
export function decodeJwt(token: string): DecodedJwt | undefined {
	if (typeof token !== "string" || Buffer.byteLength(token, "utf8") > MAX_JWT_BYTES) return undefined;
	const parts = token.split(".");
	if (parts.length !== 3 || parts.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p))) return undefined;
	const header = b64json(parts[0]);
	const claims = b64json(parts[1]);
	if (!header || !claims) return undefined;
	return { header: header as JwtHeader, claims: claims as JwtClaims, signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], "base64url") };
}

export function isAllowedAlg(alg: unknown): alg is JwtAlg {
	return typeof alg === "string" && (ALLOWED_ALGS as readonly string[]).includes(alg);
}

function hashOf(alg: JwtAlg): "sha256" | "sha384" | "sha512" {
	return alg.endsWith("512") ? "sha512" : alg.endsWith("384") ? "sha384" : "sha256";
}

/** Import an RSA JWK; `undefined` when it is not an RSA public key. */
export function importRsaJwk(jwk: Jwk): KeyObject | undefined {
	if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") return undefined;
	try {
		return createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
	} catch {
		return undefined;
	}
}

/**
 * Verify `decoded` was signed by `jwk` with its header `alg`. False for a non-allowlisted alg, a
 * JWK that declares another alg, a non-RSA key or a bad signature. Never throws.
 */
export function verifySignature(decoded: DecodedJwt, jwk: Jwk): boolean {
	const alg = decoded.header.alg;
	if (!isAllowedAlg(alg)) return false;
	if (typeof jwk.alg === "string" && jwk.alg !== alg) return false;
	if (typeof jwk.use === "string" && jwk.use !== "sig") return false;
	const key = importRsaJwk(jwk);
	if (!key) return false;
	try {
		const data = Buffer.from(decoded.signingInput, "ascii");
		if (alg.startsWith("PS")) return cryptoVerify(hashOf(alg), data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, decoded.signature);
		return cryptoVerify(hashOf(alg), data, key, decoded.signature);
	} catch {
		return false;
	}
}

export interface ClaimChecks {
	issuer: string;
	audience: string;
	/** Required when set (compared in constant time). */
	nonce?: string;
	nowSec: number;
	skewSec: number;
	/** When the token carries a `tenant` claim it must match (case-insensitive). */
	tenant?: string;
}

/** Validate the standard id_token claims. Returns the problem, `undefined` when everything checks out. */
export function checkClaims(c: JwtClaims, k: ClaimChecks): string | undefined {
	if (typeof c.sub !== "string" || !c.sub.trim()) return "missing sub";
	if (c.iss !== k.issuer) return "issuer mismatch";
	const aud = Array.isArray(c.aud) ? c.aud : typeof c.aud === "string" ? [c.aud] : [];
	if (!aud.includes(k.audience)) return "audience mismatch";
	if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) return "missing exp";
	if (c.exp + k.skewSec <= k.nowSec) return "token expired";
	if (typeof c.iat !== "number" || !Number.isFinite(c.iat)) return "missing iat";
	if (c.iat > k.nowSec + k.skewSec) return "issued in the future";
	if (typeof c.nbf === "number" && c.nbf > k.nowSec + k.skewSec) return "not yet valid";
	if (k.nonce !== undefined) {
		if (typeof c.nonce !== "string" || !constantTimeEqual(c.nonce, k.nonce)) return "nonce mismatch";
	}
	if (k.tenant !== undefined && typeof c.tenant === "string" && c.tenant.toLowerCase() !== k.tenant.toLowerCase()) return "tenant mismatch";
	return undefined;
}
