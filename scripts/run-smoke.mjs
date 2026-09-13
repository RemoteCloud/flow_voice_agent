#!/usr/bin/env node
/** Bundle every server/**\/*.smoke.ts with esbuild into build-smoke/ and run them (each exports `run()`). */
import { build } from "esbuild";
import { readdirSync, rmSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build-smoke");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function walk(dir, acc = []) {
	for (const e of readdirSync(dir)) {
		const p = path.join(dir, e);
		if (statSync(p).isDirectory()) walk(p, acc);
		else if (e.endsWith(".smoke.ts")) acc.push(p);
	}
	return acc;
}
const files = walk(path.join(root, "server"));
if (!files.length) {
	console.log("no smoke files");
	process.exit(0);
}
await build({ entryPoints: files, outdir: out, bundle: true, platform: "node", target: "node20", format: "esm", outbase: path.join(root, "server"), logLevel: "silent", banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });

let failed = 0;
for (const f of files) {
	const rel = path.relative(path.join(root, "server"), f).replace(/\.ts$/, ".js");
	const mod = await import(pathToFileURL(path.join(out, rel)).href);
	const t0 = Date.now();
	try {
		await mod.run();
		console.log(`ok   ${rel} (${Date.now() - t0} ms)`);
	} catch (err) {
		failed++;
		console.error(`FAIL ${rel}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
	}
}
if (failed) {
	console.error(`${failed} smoke file(s) failed`);
	process.exit(1);
}
console.log(`${files.length} smoke file(s) passed`);
