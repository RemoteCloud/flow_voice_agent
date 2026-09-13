/** Map a URL path onto a file in the built SPA directory. Pure (existence check injected). */
import path from "node:path";

export interface StaticFile {
	filePath: string;
	contentType: string;
	cacheControl: string;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".map": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

export function contentTypeFor(filePath: string): string {
	return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * `/` and unknown extension-less paths → `index.html` (SPA fallback, `no-cache`); `/assets/*`
 * (hashed by Vite) → immutable; anything escaping `publicDir` → `undefined`. `exists` must
 * answer true only for regular files.
 */
export function resolveStatic(publicDir: string, urlPath: string, exists: (filePath: string) => boolean): StaticFile | undefined {
	let decoded: string;
	try {
		decoded = decodeURIComponent(urlPath);
	} catch {
		return undefined;
	}
	if (decoded.includes("\0")) return undefined;
	const root = path.resolve(publicDir);
	const rel = decoded.replace(/^\/+/, "");
	const abs = path.resolve(root, rel);
	if (abs !== root && !abs.startsWith(root + path.sep)) return undefined;
	const index = path.join(root, "index.html");
	const serveIndex = (): StaticFile | undefined => (exists(index) ? { filePath: index, contentType: CONTENT_TYPES[".html"], cacheControl: "no-cache" } : undefined);
	if (abs === root || decoded.endsWith("/")) return serveIndex();
	const inAssets = /^assets[\\/]/.test(rel);
	if (exists(abs)) {
		return { filePath: abs, contentType: contentTypeFor(abs), cacheControl: inAssets ? "public, max-age=31536000, immutable" : abs === index ? "no-cache" : "public, max-age=3600" };
	}
	// hashed asset that does not exist: a real 404 is more useful than index.html
	if (inAssets || path.extname(rel)) return undefined;
	return serveIndex();
}
