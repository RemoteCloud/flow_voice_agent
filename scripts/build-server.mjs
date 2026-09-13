#!/usr/bin/env node
/** Bundle the hub into dist/server.mjs (Node 20+, ws bundled, no native modules). */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({
	entryPoints: ["server/main.ts"],
	outfile: "dist/server.mjs",
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	sourcemap: true,
	banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
	external: [],
	logLevel: "info",
});
console.log("dist/server.mjs written");
