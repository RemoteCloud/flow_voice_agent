#!/usr/bin/env node
/**
 * Local development: fake Maranics (:8090) + hub with the built PWA (:8443), rebuilding the server
 * bundle and restarting on change. Open http://127.0.0.1:8443 and "Sign in as Bridge Officer (dev)".
 * Set HUB_OIDC_* to use the fake OIDC provider instead of the dev user, or point HUB_MARANICS_HOST
 * at a real environment. Works on Windows, macOS and Linux (Node launcher only).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeMaranics } from "./lib/fake-maranics.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HUB_PORT ?? 8443);
const useFake = !process.env.HUB_MARANICS_HOST;
let fake;
if (useFake) {
	fake = await startFakeMaranics({ port: Number(process.env.FAKE_PORT ?? 8090), tenant: "demo", oidc: { clientId: "flow-voice", clientSecret: "dev-client-secret-0123456789", redirectUri: `http://127.0.0.1:${port}/api/auth/callback` }, log: (l) => console.log(`[maranics] ${l}`) });
	console.log(`[dev] fake Maranics on ${fake.url} (OIDC issuer ${fake.oidc.issuer})`);
}

const env = {
	...process.env,
	HUB_SECRET: process.env.HUB_SECRET ?? "dev-secret-change-me-0123456789",
	HUB_PORT: String(port),
	HUB_DATA_DIR: process.env.HUB_DATA_DIR ?? path.join(root, "data"),
	HUB_PUBLIC_DIR: path.join(root, "dist", "public"),
	HUB_PUBLIC_URL: process.env.HUB_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
	LOG_LEVEL: process.env.LOG_LEVEL ?? "debug",
	...(useFake
		? {
				HUB_TENANT: "demo",
				HUB_MARANICS_HOST: fake.url,
				DEV_USER: process.env.DEV_USER ?? "Bridge Officer",
				DEV_MARANICS_TOKEN: "t0k3n",
				SERVICE_TOKENS: process.env.SERVICE_TOKENS ?? "dev-service-token",
				...(process.env.HUB_OIDC_ISSUER ? {} : process.env.USE_FAKE_OIDC ? { HUB_OIDC_ISSUER: fake.oidc.issuer, HUB_OIDC_CLIENT_ID: "flow-voice", HUB_OIDC_CLIENT_SECRET: "dev-client-secret-0123456789" } : {}),
			}
		: {}),
};

if (!existsSync(path.join(root, "dist", "public", "index.html"))) console.log("[dev] dist/public missing — run `npm run build:web` (or `npx vite web` for HMR on :5173)");

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const watcher = spawn(npx, ["esbuild", "server/main.ts", "--bundle", "--platform=node", "--target=node20", "--format=esm", "--outfile=dist/server.mjs", "--sourcemap", "--watch", "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
const hub = spawn(process.execPath, ["--watch", "dist/server.mjs"], { cwd: root, env, stdio: "inherit" });

const stop = () => {
	watcher.kill();
	hub.kill();
	fake?.close();
	setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
hub.on("exit", (code) => {
	if (code !== null && code !== 0) console.log(`[dev] hub exited with ${code}`);
});
