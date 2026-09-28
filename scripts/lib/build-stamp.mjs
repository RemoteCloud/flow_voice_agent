/** "04c6827 2026-09-15 20:03Z" — git short sha (+ "*" when the tree is dirty) and the build minute. Shown in the UI so a stale bundle is obvious. */
import { execSync } from "node:child_process";

export function buildStamp() {
	let sha = "nogit";
	let dirty = "";
	try {
		sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
		dirty = execSync("git status --porcelain --untracked-files=no", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() ? "*" : "";
	} catch {
		/* no git */
	}
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${sha}${dirty} ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}
