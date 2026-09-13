#!/usr/bin/env node
/** Run the built hub with deploy/.env (no Docker): `npm run start:env`. Builds nothing — run `npm run build` first. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = process.argv[2] ?? path.join(root, "deploy", ".env");
if (!existsSync(envFile)) {
	console.error(`no env file at ${envFile} — copy deploy/.env.example to deploy/.env and fill it in`);
	process.exit(2);
}
const env = { ...process.env };
for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
	const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
	if (!m || line.trim().startsWith("#")) continue;
	env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const missing = Object.entries(env).filter(([k, v]) => k.startsWith("HUB_") && /<<.*>>/.test(v)).map(([k]) => k);
if (missing.length) {
	console.error(`fill in ${missing.join(", ")} in ${envFile} (values still contain <<...>> placeholders)`);
	process.exit(2);
}
env.HUB_PORT ??= "8443";
env.HUB_DATA_DIR ??= path.join(root, "data");
env.HUB_PUBLIC_DIR ??= path.join(root, "dist", "public");
const hub = spawn(process.execPath, ["dist/server.mjs"], { cwd: root, env, stdio: "inherit" });
hub.on("exit", (code) => process.exit(code ?? 0));
