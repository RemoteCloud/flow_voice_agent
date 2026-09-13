/** fetch wrapper with timeout + typed HTTP errors. SDK-free (uses Node 20 global fetch). */

export class HttpError extends Error {
	readonly status: number;
	readonly retryAfterMs?: number;
	readonly bodyText?: string;

	constructor(status: number, message: string, opts: { retryAfterMs?: number; bodyText?: string } = {}) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.retryAfterMs = opts.retryAfterMs;
		this.bodyText = opts.bodyText;
	}
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchJsonOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchImpl?: FetchLike;
}

export interface JsonResponse<T> {
	body: T;
	status: number;
	headers: Headers;
}

/**
 * Perform a request and parse JSON. Throws `HttpError` for non-2xx, `Error("timeout")` on
 * timeout, and rethrows network errors. `204`/empty body resolves to `undefined`.
 */
export async function fetchJson<T = unknown>(url: string, init: RequestInit = {}, opts: FetchJsonOptions = {}): Promise<T> {
	return (await fetchJsonFull<T>(url, init, opts)).body;
}

/** Like `fetchJson` but also returns status + response headers (e.g. `X-Total-Count`). */
export async function fetchJsonFull<T = unknown>(url: string, init: RequestInit = {}, opts: FetchJsonOptions = {}): Promise<JsonResponse<T>> {
	const timeoutMs = opts.timeoutMs ?? 8000;
	const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
	const controller = new AbortController();
	let timedOut = false;
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error("timeout"));
			reject(new Error("timeout"));
		}, timeoutMs);
	});
	const onOuterAbort = () => controller.abort(opts.signal?.reason);
	opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
	try {
		const res = await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timeout]);
		if (!res.ok) {
			let bodyText: string | undefined;
			try {
				bodyText = (await res.text()).slice(0, 500);
			} catch {
				/* ignore */
			}
			const ra = res.headers.get("retry-after");
			const retryAfterMs = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined;
			throw new HttpError(res.status, `HTTP ${res.status}`, { retryAfterMs, bodyText });
		}
		if (res.status === 204) return { body: undefined as T, status: res.status, headers: res.headers };
		const text = await res.text();
		if (!text) return { body: undefined as T, status: res.status, headers: res.headers };
		return { body: JSON.parse(text) as T, status: res.status, headers: res.headers };
	} catch (err) {
		if (timedOut) throw new Error("timeout");
		throw err;
	} finally {
		if (timer) clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onOuterAbort);
	}
}

/** Short, token-free description of an error for status text / logs. */
export function shortMessage(err: unknown): string {
	if (err instanceof HttpError) return `HTTP ${err.status}`;
	if (err instanceof Error) {
		if (err.message === "timeout") return "timeout";
		const cause = (err as { cause?: { code?: string } }).cause;
		if (cause?.code) return cause.code;
		return err.message.slice(0, 60);
	}
	return String(err).slice(0, 60);
}

/** Normalise a user-entered base URL: trim, strip trailing slashes; `undefined` when invalid. */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
	const v = (raw ?? "").trim().replace(/\/+$/, "");
	if (!/^https?:\/\/[^\s/]+/i.test(v)) return undefined;
	return v;
}
