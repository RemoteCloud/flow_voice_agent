/** Thin fetch wrapper for /api (same origin as the hub; cookies carry the session). */
import type { ApiError } from "../../server/api.js";

export class ApiClientError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ApiClientError";
	}
}

let unauthorizedHandler: (() => void) | undefined;
export function setUnauthorizedHandler(fn: (() => void) | undefined): void {
	unauthorizedHandler = fn;
}

export const AUTH_LOGIN_URL = "/api/auth/login";

async function request<T>(method: string, path: string, body?: unknown, opts: { noAuthRedirect?: boolean } = {}): Promise<T> {
	const res = await fetch(`/api/${path.replace(/^\//, "")}`, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : {},
		body: body !== undefined ? JSON.stringify(body) : undefined,
		credentials: "same-origin",
	});
	if (res.status === 401 && !opts.noAuthRedirect) unauthorizedHandler?.();
	if (!res.ok) {
		let err: Partial<ApiError> = {};
		try {
			err = (await res.json()) as ApiError;
		} catch {
			/* not json */
		}
		throw new ApiClientError(res.status, err.code ?? "HTTP", err.error ?? `HTTP ${res.status}`);
	}
	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

export const api = {
	get: <T>(path: string, opts?: { noAuthRedirect?: boolean }) => request<T>("GET", path, undefined, opts),
	post: <T>(path: string, body?: unknown, opts?: { noAuthRedirect?: boolean }) => request<T>("POST", path, body ?? {}, opts),
	put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
	del: <T>(path: string) => request<T>("DELETE", path),
};

export function toApiError(e: unknown): ApiClientError {
	if (e instanceof ApiClientError) return e;
	return new ApiClientError(0, "NETWORK", e instanceof Error ? e.message : String(e));
}

/** ws(s)://host/v1/… on the page's origin. */
export function wsUrl(path: string): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}${path}`;
}
