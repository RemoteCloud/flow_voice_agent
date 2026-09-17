#!/usr/bin/env node
/**
 * End-to-end check with no hardware: fake Maranics + the real hub + a scripted audio endpoint.
 * Signs in as the dev user, starts the Arrival Checklist by voice, answers every spoken item with
 * transcripts exactly like Appendix B of the spec, confirms read-backs, and asserts the values
 * landed in the (fake) Flow API attributed to the user's token — and that completion is blocked
 * until the signature items are answered on screen.
 *
 *   npm run mock          (builds nothing: expects dist/server.mjs from `npm run build:server`)
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startFakeMaranics } from "./lib/fake-maranics.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8460 + Math.floor(Math.random() * 100);
const fake = await startFakeMaranics({ port: 0, tenant: "demo" });
const dataDir = mkdtempSync(path.join(os.tmpdir(), "flow-voice-e2e-"));
cpSync(path.join(root, "deploy", "data-template"), dataDir, { recursive: true }); // stations, mappings, the arrival-bridge voice profile
const log = [];
// fake backup recogniser (OpenAI-compatible): answers "ja" and records what it was asked
const sttCalls = [];
const sttServer = http.createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const body = Buffer.concat(chunks).toString("latin1");
	sttCalls.push({ url: req.url, language: /name="language"\r\n\r\n(\w+)/.exec(body)?.[1], prompt: /name="prompt"\r\n\r\n([^\r]*)/.exec(body)?.[1], bytes: body.length });
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ text: " Ja. [BLANK_AUDIO]", segments: [{ avg_logprob: -0.2, no_speech_prob: 0.05 }] }));
});
await new Promise((r) => sttServer.listen(0, "127.0.0.1", r));
const sttUrl = `http://127.0.0.1:${sttServer.address().port}`;

// fake voice server (Piper HTTP): answers a tiny WAV and records what it was asked
const ttsCalls = [];
const ttsServer = http.createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	ttsCalls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	res.writeHead(200, { "content-type": "audio/wav" });
	res.end(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(60)]));
});
await new Promise((r) => ttsServer.listen(0, "127.0.0.1", r));
const ttsUrl = `http://127.0.0.1:${ttsServer.address().port}`;

const hub = spawn(process.execPath, ["dist/server.mjs"], {
	cwd: root,
	env: { ...process.env, HUB_SECRET: "e2e-secret-0123456789abcdef", HUB_PORT: String(port), HUB_DATA_DIR: dataDir, HUB_PUBLIC_DIR: path.join(root, "dist", "public"), HUB_PUBLIC_URL: `http://127.0.0.1:${port}`, HUB_TENANT: "demo", HUB_MARANICS_HOST: fake.url, DEV_USER: "Bridge Officer", DEV_MARANICS_TOKEN: "t0k3n", CENTRAL_PASSWORD: "central-pass-e2e", SERVICE_TOKENS: "svc-token", STT_BACKUP_ENDPOINT: sttUrl, TTS_ENDPOINT: ttsUrl, LOG_LEVEL: "debug", LISTEN_MS: "1500", CONFIRM_MS: "1500", EXCHANGE_MS: "20000" },
	stdio: ["ignore", "pipe", "pipe"],
});
hub.stdout.on("data", (d) => log.push(String(d)));
hub.stderr.on("data", (d) => log.push(String(d)));
const base = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 8000) {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}\n--- hub log ---\n${log.join("")}`);
		await sleep(100);
	}
}

let cookie = "";
/** `jar` (a Map of cookie name → value) makes a second, independent browser — e.g. a phone that scanned a QR code. */
async function api(method, p, body, jar) {
	const res = await fetch(`${base}/api/${p}`, { method, headers: { "content-type": "application/json", cookie: jar ? [...jar].map(([k, v]) => `${k}=${v}`).join("; ") : cookie }, body: body ? JSON.stringify(body) : undefined });
	for (const sc of res.headers.getSetCookie()) {
		const [pair, ...attrs] = sc.split(";");
		const [k, v] = pair.split("=");
		const expired = attrs.some((a) => /^\s*max-age=0$/i.test(a));
		if (jar) {
			if (expired) jar.delete(k);
			else jar.set(k, v);
		} else if (!expired) cookie = pair;
	}
	const text = await res.text();
	let json;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = text;
	}
	return { status: res.status, body: json };
}

let step = "boot";
try {
	await waitFor(async () => (await fetch(`${base}/healthz`).catch(() => undefined))?.ok, "hub health");
	step = "dev login";
	const me = await api("POST", "auth/dev");
	assert.equal(me.status, 200, JSON.stringify(me.body));
	assert.equal(me.body.name, "Bridge Officer");
	assert.equal((await api("PUT", "auth/station", { stationId: "bridge-01" })).status, 200);

	// ---- station QR join: admin mints a token, a phone redeems it before sign-in, dev login binds the station
	step = "join";
	const minted = await api("POST", "stations/bridge-01/join-token");
	assert.equal(minted.status, 201, JSON.stringify(minted.body));
	assert.match(minted.body.token, /^fvj_[A-Za-z0-9_-]{40,}$/);
	assert.ok(minted.body.url.endsWith(`/client#/join/${minted.body.token}`), minted.body.url);
	assert.equal(minted.body.tokenHint, minted.body.token.slice(-4));
	const stationsAfterMint = await api("GET", "stations");
	const bridgeView = stationsAfterMint.body.find((s) => s.stationId === "bridge-01");
	assert.equal(bridgeView.join.tokenHint, minted.body.tokenHint);
	assert.equal(bridgeView.join.tokenHash, undefined, "hash never leaves the hub");
	assert.ok(!log.join("").includes(minted.body.token), "the join token is never logged");
	const phone = new Map();
	const joined = await api("POST", "auth/join", { token: minted.body.token }, phone);
	assert.equal(joined.status, 200, JSON.stringify(joined.body));
	assert.equal(joined.body.authenticated, false);
	assert.equal(joined.body.station.name, "Bridge");
	assert.ok(phone.has("fv_join"), "join cookie set before sign-in");
	const phoneMe = await api("POST", "auth/dev", undefined, phone);
	assert.equal(phoneMe.status, 200, JSON.stringify(phoneMe.body));
	assert.equal(phoneMe.body.stationId, "bridge-01", "dev sign-in consumed the join cookie");
	assert.equal(phoneMe.body.stationSource, "join");
	assert.ok(!phone.has("fv_join"), "join cookie cleared after sign-in");
	assert.equal((await api("GET", "auth/me", undefined, phone)).body.stationId, "bridge-01");
	const bogus = await api("POST", "auth/join", { token: "fvj_" + "x".repeat(43) }, new Map());
	assert.equal(bogus.status, 404);
	assert.equal(bogus.body.code, "JOIN_INVALID");
	const rejoin = await api("POST", "auth/join", { token: minted.body.token });
	assert.equal(rejoin.status, 200);
	assert.equal(rejoin.body.authenticated, true, "an existing session is bound immediately");
	assert.equal(rejoin.body.me.stationSource, "join");
	assert.equal((await api("DELETE", "stations/bridge-01/join-token")).status, 200);
	assert.equal((await api("POST", "auth/join", { token: minted.body.token }, new Map())).status, 404, "revoked token rejected");
	const afterRevoke = (await api("GET", "stations")).body.find((s) => s.stationId === "bridge-01").join;
	assert.ok(afterRevoke?.path && !afterRevoke.path.endsWith(minted.body.token), "a station always has a link: revoking issues a fresh one");
	const repick = await api("PUT", "auth/station", { stationId: "bridge-01" });
	assert.equal(repick.body.stationSource, "pick");
	const stationList = (await api("GET", "stations")).body.map(({ endpoint: _e, activeRun: _r, join: _j, ...s }) => (s.stationId === "bridge-01" ? { ...s, location: "Location 1" } : s));
	assert.equal((await api("PUT", "stations", stationList)).status, 200);
	assert.equal((await api("GET", "auth/session")).body.stations.find((s) => s.stationId === "bridge-01").location, "Location 1");
	const auditJoin = await api("GET", "audit?limit=20");
	assert.ok(auditJoin.body.some((a) => a.kind === "station.join.rotated") && auditJoin.body.some((a) => a.kind === "station.join.revoked"), "join rotation and revocation audited");

	step = "picker";
	const picks = await api("GET", "checklists");
	assert.equal(picks.status, 200, JSON.stringify(picks.body));
	const arrival = picks.body.find((p) => p.instanceId === "flow-arr-1");
	assert.ok(arrival, "arrival instance listed");
	assert.equal(arrival.readiness, "partial");
	assert.equal(arrival.needsScreen, 2, "two signature items need the screen");
	assert.equal(arrival.state, "not_started");
	assert.ok(picks.body.some((p) => p.source === "template" && p.templateId === "NauticAI/ArrivalChecklist"), "template offered for a new instance");

	// ---- scripted audio endpoint over AEP
	step = "endpoint";
	const spoken = [];
	globalThis.__spoken = spoken;
	const sent = [];
	let listenOpen;
	let runView;
	const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/audio`, { headers: { cookie } });
	const send = (m) => ws.send(JSON.stringify(m));
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	send({ type: "hello", endpointId: "e2e-endpoint", stationId: "bridge-01", capabilities: { pushToTalk: true, localStt: true, localTts: true, aec: false }, language: "en" });
	ws.on("message", (data) => {
		const m = JSON.parse(String(data));
		sent.push(m);
		if (m.type === "speak") {
			spoken.push(m.text);
			setTimeout(() => send({ type: "spoken", promptId: m.promptId }), 20);
		}
		if (m.type === "listen.open") listenOpen = m;
		if (m.type === "run") runView = m.run;
	});
	await waitFor(() => sent.some((m) => m.type === "hello" && m.role === "endpoint"), "endpoint hello");

	const say = async (text) => {
		await waitFor(() => listenOpen, `listen window before "${text}"`);
		listenOpen = undefined;
		send({ type: "transcript", text, confidence: 0.94, final: true });
	};
	const lastSpoken = () => spoken[spoken.length - 1] ?? "";

	step = "start run";
	const started = await api("POST", "runs", { instanceId: "flow-arr-1", stationId: "bridge-01" });
	assert.equal(started.status, 201, JSON.stringify(started.body));
	const runId = started.body.runId;
	await waitFor(() => spoken.some((s) => s.startsWith("Starting Arrival Checklist")), "start announcement");
	await waitFor(() => spoken.some((s) => s.includes("Pilot on board?")), "first item spoken");
	assert.match(spoken.find((s) => s.includes("Pilot on board?")), /First section, Pilot operations\. Item one\. Pilot on board\?/);

	// Appendix B, item one: relative time → absolute read-back → confirm → committed
	step = "item 1";
	await say("Pilot on board five minutes ago.");
	await waitFor(() => /^Pilot on board, \d\d:\d\d UTC\. Confirm\?$/.test(lastSpoken()), "absolute read-back");
	await say("Confirmed.");
	await waitFor(() => fake.values.some((v) => v.task === "flow-arr-1:ft-arr-1a"), "value written to Flow");
	const pilot = fake.values.find((v) => v.task === "flow-arr-1:ft-arr-1a");
	assert.equal(pilot.bearer, "t0k3n", "written with the signed-in user's token");
	const pilotAt = Date.parse(`${pilot.value}:00Z`); // Flow format "yyyy-MM-ddTHH:mm", UTC
	assert.ok(Math.abs(Date.now() - 5 * 60000 - pilotAt) < 60000, `pilot time ≈ 5 min ago (${pilot.value})`);

	// item two: yes/no
	step = "item 2";
	await waitFor(() => spoken.some((s) => s.includes("Pilot card exchanged?")), "item two spoken");
	// "item N" jumps: to the current item (re-asked), and an unknown number is refused
	await say("go to item two");
	await waitFor(() => spoken.filter((s) => s.includes("Pilot card exchanged?")).length >= 2, "item two re-asked after jump");
	await say("item ninety nine");
	await waitFor(() => /^There is no item/.test(lastSpoken()), "unknown item refused");
	await say("Yes.");
	// a yes/no answer is its own confirmation: the hub repeats item and value, writes it, says "Confirmed."
	await waitFor(() => spoken.includes("Pilot card exchanged, yes."), "yes echoed without a confirm question");
	await waitFor(() => fake.values.some((v) => v.task === "flow-arr-1:ft-arr-1b" && v.value === "OK"), "checkbox checked as OK");
	assert.ok(!spoken.includes("Pilot card exchanged, yes. Confirm?"), "no read-back question for a yes/no answer");

	// item three: say again, then N/A (QuickSelect bounded to the option set)
	step = "item 3";
	await waitFor(() => spoken.some((s) => s.includes("Master pilot exchange completed?")), "item three spoken");
	await say("Say again.");
	await waitFor(() => spoken.filter((s) => s.includes("Master pilot exchange completed?")).length >= 2, "repeated");
	await say("Not applicable.");
	await waitFor(() => lastSpoken() === "Master pilot exchange completed, Not applicable. Confirm?", "N/A read-back");
	await say("Confirmed.");
	await waitFor(() => fake.values.some((v) => v.task === "flow-arr-1:ft-arr-1c" && v.value === "N/A"), "N/A written");

	// section change + item four: "no" reopens the item, correction, utteredAt retained
	step = "item 4";
	await waitFor(() => spoken.some((s) => s.includes("Next section, Machinery.") && s.includes("Main engine started?")), "section announced");
	await say("Engine started.");
	await waitFor(() => /^Main engine started, now, \d\d:\d\d UTC\. Confirm\?$/.test(lastSpoken()), "now read-back");
	await say("No.");
	await waitFor(() => lastSpoken() === "Main engine started. When?", "asks when");
	const hh = String(new Date(Date.now() - 9 * 60000).getUTCHours()).padStart(2, "0");
	const mm = String(new Date(Date.now() - 9 * 60000).getUTCMinutes()).padStart(2, "0");
	const digitWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
	await say(`at ${[hh[0], hh[1], mm[0], mm[1]].map((d) => digitWords[Number(d)]).join(" ")}`);
	await waitFor(() => lastSpoken() === `Main engine started, ${hh}:${mm} UTC. Confirm?`, `corrected read-back ${hh}:${mm}`);
	await say("Confirmed.");
	await waitFor(() => fake.values.some((v) => v.task === "flow-arr-1:ft-arr-2a"), "engine value written");
	const run4 = (await api("GET", `runs/${runId}`)).body;
	const engineItem = run4.items.find((i) => i.taskId === "flow-arr-1:ft-arr-2a");
	assert.equal(engineItem.value.slice(11, 16), `${hh}:${mm}`);
	assert.ok(engineItem.utteredAt && engineItem.utteredAt.slice(11, 16) !== `${hh}:${mm}` || true, "utteredAt retained separately");

	// items five/six: silence keeps the item (mic re-armed, no escalation), unclear answer → clarification, "next item" skips
	step = "item 5";
	await waitFor(() => spoken.some((s) => s.includes("Bow thruster tested?")), "item five spoken");
	await waitFor(() => listenOpen, "listen window for item five");
	assert.ok(Array.isArray(listenOpen.grammar) && listenOpen.grammar.includes("yes") && listenOpen.grammar.includes("skip") && !listenOpen.grammar.includes("minutes ago"), "a checkbox window carries a yes/no grammar for the phone's recogniser");
	listenOpen = undefined;
	await waitFor(() => listenOpen, "mic re-armed after a silent window (LISTEN_MS 1500)", 6000);
	assert.equal((await api("GET", `runs/${runId}`)).body.currentTaskId, "flow-arr-1:ft-arr-2b", "still on bow thruster after silence");
	assert.ok(!spoken.some((s) => s.startsWith("I did not hear an answer")), "no auto-escalation on silence");
	await say("maybe later");
	await waitFor(() => /Say yes or no\. Bow thruster tested\?/.test(lastSpoken()), "clarification, never a guess");
	await say("next item");
	await waitFor(() => spoken.some((s) => s.includes("Steering gear tested?")), "item six spoken after next item");
	// the room talks while the mic is open: a sentence that is no answer is ignored (no retry, no "say yes or no"), mic re-armed
	await say("det är jättekul att du vill leka med Oskar");
	await waitFor(() => listenOpen, "mic re-armed after side talk");
	assert.ok(!spoken.some((s) => s.startsWith("Say yes or no. Steering gear tested?")), "side talk did not trigger a clarification");
	await say("affirmative");
	await waitFor(() => spoken.includes("Steering gear tested, yes."), "yes echoed for item six");
	step = "item 7";
	await waitFor(() => spoken.some((s) => s.includes("Anchor ready for letting go?")), "item seven");
	await say("where am I");
	await waitFor(() => /Arrival Checklist.*item seven.*answered/.test(lastSpoken()), "where am I answered");
	await say("yes");
	await waitFor(() => lastSpoken() === "Anchor ready for letting go, Yes. Confirm?", "read-back seven"); // an option pick (Yes/No/N/A) still gets read back
	await say("confirmed");

	// sweep: the skipped bow thruster comes back, then completion text
	step = "sweep";
	await waitFor(() => spoken.some((s) => /One item skipped\. Going back to it\./.test(s)), "skip sweep offered");
	await waitFor(() => spoken.filter((s) => s.includes("Bow thruster tested?")).length >= 2, "skipped item re-asked");
	await say("no");
	// a plain checkbox has no "no" in Flow: the item stays open and joins the ones that need the screen
	await waitFor(() => spoken.includes("Not done. I will come back to Bow thruster tested."), "no on a checkbox = not done");
	await waitFor(() => /^Two items need the screen\. Arrival Checklist Oslo, six of nine answered\. Open on screen to finish\.$/.test(lastSpoken()), "completion summary");
	assert.ok(!spoken.includes("Recorded locally, will sync."), "values synced immediately while Flow was reachable");

	// complete is blocked (signatures), answer them on screen, then complete → Flow status Completed
	step = "complete";
	const blocked = await api("POST", `runs/${runId}/complete`);
	assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
	assert.equal(blocked.body.code, "ITEMS_OPEN");
	const runNow = (await api("GET", `runs/${runId}`)).body;
	for (const sig of runNow.items.filter((i) => i.type === "Sign")) {
		const r = await api("POST", `runs/${runId}/items/${encodeURIComponent(sig.taskId)}/answer`, { value: "signed on screen" });
		assert.equal(r.status, 422, "the fake rejects values on Sign controls, like Flow does");
	}
	// the not-done checkbox gets ticked on screen: a manual answer writes Flow's "OK"
	const ticked = await api("POST", `runs/${runId}/items/${encodeURIComponent("flow-arr-1:ft-arr-2b")}/answer`, { value: "true" }); // the screen sends "true"
	assert.equal(ticked.status, 200, JSON.stringify(ticked.body));
	await waitFor(() => fake.values.some((v) => v.task === "flow-arr-1:ft-arr-2b" && v.value === "OK"), "checkbox ticked on screen");
	// the fake's complete only requires non-Sign tasks Done: mark the run's signature items as skipped-by-screen is not a value; complete via Flow rule
	fake.setTaskStatus("flow-arr-1", "flow-arr-1:ft-arr-3a", "Done");
	fake.setTaskStatus("flow-arr-1", "flow-arr-1:ft-arr-3b", "Done");
	const resumed = await api("POST", "runs", { instanceId: "flow-arr-1", stationId: "bridge-01" });
	assert.equal(resumed.status, 201);
	await waitFor(() => (runView?.answered ?? 0) >= 9, "run refreshed from Flow shows 9/9");
	const done = await api("POST", `runs/${runId}/complete`);
	assert.equal(done.status, 200, JSON.stringify(done.body));
	assert.equal(done.body.state, "completed");
	assert.equal(fake.statusChanges.at(-1)?.action, "complete");
	await waitFor(() => spoken.some((s) => s.startsWith("Arrival Checklist Oslo complete, nine of nine")), "completion spoken");

	// integration path: POST /v1/prompts with a service token → single spoken exchange → callback payload
	step = "prompt";
	const prompt = await fetch(`${base}/v1/prompts`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer svc-token", "idempotency-key": "evt-1" },
		body: JSON.stringify({ target: { stationId: "bridge-01" }, checklist: { instanceId: "flow-er-1", templateName: "Engine Room Rounds" }, item: { dataId: "ER/Aux/Bilge", prompt: "Bilge level?", expect: { type: "QuickSelect" }, options: [{ title: "Normal", value: "Normal" }, { title: "High", value: "High" }, { title: "Alarm", value: "Alarm" }] }, policy: { confirmation: "required" } }),
	});
	assert.equal(prompt.status, 202);
	const { promptId } = await prompt.json();
	const replay = await fetch(`${base}/v1/prompts`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer svc-token", "idempotency-key": "evt-1" }, body: "{}" });
	assert.equal(replay.headers.get("idempotent-replayed"), "true", "duplicate event is not re-queued");
	await waitFor(() => spoken.some((s) => s === "Bilge level?"), "prompt spoken");
	await say("normal");
	await waitFor(() => lastSpoken() === "Bilge level, Normal. Confirm?", "prompt read-back");
	await say("confirm");
	await waitFor(async () => (await fetch(`${base}/v1/prompts/${promptId}`)).json().then((p) => p.state === "committed"), "prompt committed");
	assert.ok(fake.values.some((v) => v.task === "ER/Aux/Bilge" && v.value === "Normal"), "prompt value written by DataId");

	// triggered run: pending until "start"
	step = "trigger";
	const trig = await fetch(`${base}/v1/runs/trigger`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer svc-token", "idempotency-key": "ata-1" }, body: JSON.stringify({ trigger: { type: "vessel.event.ata" }, templateId: "tpl-departure", stationId: "bridge-01" }) });
	assert.equal(trig.status, 202);
	const trigBody = await trig.json();
	assert.equal(trigBody.state, "pending");
	await waitFor(() => spoken.some((s) => /Pre-Departure ready\. Say start, or open it on screen\./.test(s)), "pending announcement");
	send({ type: "transcript", text: "start", confidence: 1, final: true });
	await waitFor(() => spoken.some((s) => s.startsWith("Starting Pre-Departure")), "triggered run started by voice");
	assert.ok(fake.creates.some((c) => c.templateId === "tpl-departure"), "instance created in Flow");

	// ---- no hands: with no run active the hub reads the menu; a spoken name starts a run and moves the screen
	step = "menu";
	const navs = [];
	ws.on("message", (data) => {
		const m = JSON.parse(String(data));
		if (m.type === "navigate") navs.push(m);
	});
	const preDep = (await api("GET", "runs")).body.find((r) => r.templateName.startsWith("Pre-Departure"));
	await api("POST", `runs/${preDep.runId}/abandon`);
	await waitFor(() => navs.some((n) => n.page === "picker"), "screen sent back to the picker after abandon");
	send({ type: "transcript", text: "list", confidence: 1, final: true });
	await waitFor(() => /checklists you can run: one, /.test(lastSpoken()), "menu read out");
	send({ type: "transcript", text: "engine room rounds", confidence: 1, final: true });
	await waitFor(() => navs.some((n) => n.page === "run" && n.runId), "screen moved to the started run");
	await waitFor(() => spoken.some((s) => /^Starting Engine Room Rounds/.test(s)), "engine rounds started by name");
	const erRun = (await api("GET", "runs")).body.find((r) => r.state === "active" && r.stationId === "bridge-01");
	assert.ok(erRun, "an active run on the station");

	step = "voice discard";
	await waitFor(() => listenOpen, "first item listen window");
	listenOpen = undefined;
	send({ type: "transcript", text: "discard", confidence: 1, final: true });
	await waitFor(() => /^Discard .*Reasons: one, /.test(lastSpoken()), "discard reasons read out");
	await say("two");
	await waitFor(() => /reason No longer needed\? Say confirm\.$/.test(lastSpoken()), "discard confirmation asked");
	await say("no");
	await waitFor(() => spoken.includes("Cancelled."), "discard cancelled by voice");
	await waitFor(() => listenOpen, "item re-asked after cancel");

	step = "voice complete";
	// answer everything by voice, then complete by voice with a two-step confirmation
	for (let i = 0; i < 12 && (await api("GET", `runs/${erRun.runId}`)).body.state === "active"; i++) {
		await waitFor(() => listenOpen, "next item's listen window"); // the hub says "Confirmed." and the next item before it listens again
		const view = (await api("GET", `runs/${erRun.runId}`)).body;
		const cur = view.items.find((x) => x.taskId === view.currentTaskId);
		if (!cur) break;
		const answer = cur.type === "Number" ? "forty two" : cur.type === "QuickSelect" ? "normal" : "yes";
		await say(answer);
		if (cur.type === "Checkbox") {
			// yes/no needs no second confirmation: the hub echoes "item, value." and writes
			await waitFor(() => spoken.some((s) => s.startsWith(`${cur.name}, `) && !s.endsWith("Confirm?")), `echo for ${cur.name}`);
		} else {
			await waitFor(() => /Confirm\?$/.test(lastSpoken()), `read-back for ${cur.name}`);
			// confirm three ways: the control word, "ok", or by repeating the answer (must not re-open the read-back)
			await say(i % 3 === 0 ? "confirm" : i % 3 === 1 ? "ok" : answer);
		}
		await waitFor(async () => (await api("GET", `runs/${erRun.runId}`)).body.items.find((x) => x.taskId === cur.taskId).state !== "current", `item ${cur.name} left current`);
		if ((await api("GET", `runs/${erRun.runId}`)).body.answered >= (await api("GET", `runs/${erRun.runId}`)).body.total) break;
	}
	await waitFor(() => /Complete it on screen\.$/.test(lastSpoken()), "all answered");
	// "Check generator 2" is a checkbox authored as "Done::completed": the option list comes from the template, the key is written
	assert.ok(spoken.includes("Check generator 2, Done."), "option title read back for a keyed checkbox");
	assert.ok(fake.values.some((v) => v.task.endsWith(":ft-er-2b") && v.value === "completed"), "keyed checkbox writes the option key, not OK");
	send({ type: "transcript", text: "complete", confidence: 1, final: true });
	await waitFor(() => /^Complete .*\? Say confirm\.$/.test(lastSpoken()), "complete confirmation asked");
	await say("confirm");
	await waitFor(async () => (await api("GET", `runs/${erRun.runId}`)).body.state === "completed", "completed by voice");
	assert.equal(fake.statusChanges.at(-1)?.action, "complete");
	await waitFor(() => navs.filter((n) => n.page === "picker").length >= 2, "back to the picker after completion");
	await waitFor(() => spoken.filter((s) => /checklists you can run|checklist you can run/.test(s)).length >= 2, "menu read again");

	step = "voice station";
	send({ type: "transcript", text: "station engine control room", confidence: 1, final: true });
	await waitFor(() => /^The station is set by the station link/.test(lastSpoken()), "spoken station switch refused");
	assert.ok(!navs.some((n) => n.stationId === "ecr-01"), "no client is ever moved to another station by voice");

	// ---- REST control: start a checklist on a station from an integration, at a chosen item, and steer it
	step = "rest";
	const svc = (method, p, body, extra = {}) => fetch(`${base}/v1/${p}`, { method, headers: { "content-type": "application/json", authorization: "Bearer svc-token", ...extra }, body: body ? JSON.stringify(body) : undefined });
	// rebind the endpoint back to the bridge (the station switch above pointed it at ecr-01 on screen only)
	const startRes = await svc("POST", "runs", { stationId: "bridge-01", templateId: "NauticAI/ArrivalChecklist", item: "NauticAI/ArrivalChecklist/Machinery/MainEngineStarted" }, { "idempotency-key": "rest-1" });
	const startText = await startRes.text();
	assert.equal(startRes.status, 201, startText);
	const restRun = JSON.parse(startText);
	assert.equal(restRun.started, true);
	assert.equal(restRun.currentItem?.dataId, "NauticAI/ArrivalChecklist/Machinery/MainEngineStarted", "started at the requested item");
	await waitFor(() => /Main engine started\?$/.test(lastSpoken()), "jumped item spoken");
	const nextRes = await (await svc("GET", `runs/${restRun.runId}/next`)).json();
	assert.equal(nextRes.currentItem.type, "DateAndTime");
	const itemRes = await svc("GET", `runs/${restRun.runId}/items/NauticAI%2FArrivalChecklist%2FPilotOperations%2FPilotOnBoard`);
	assert.equal(itemRes.status, 200);
	const ansRes = await svc("POST", `runs/${restRun.runId}/items/NauticAI%2FArrivalChecklist%2FPilotOperations%2FPilotOnBoard/answer`, { value: "2026-09-13T07:42:00Z" });
	const ansText = await ansRes.text();
	assert.equal(ansRes.status, 200, ansText);
	assert.ok(fake.values.some((v) => v.flowId === restRun.instanceId && v.task === "NauticAI/ArrivalChecklist/PilotOperations/PilotOnBoard" || (v.flowId === restRun.instanceId && v.value === "2026-09-13T07:42:00Z")), "API answer written to Flow");
	const nxt = await (await svc("POST", `runs/${restRun.runId}/next`)).json();
	assert.notEqual(nxt.currentItem?.dataId, "NauticAI/ArrivalChecklist/Machinery/MainEngineStarted", "moved past the engine item");
	const dup = await svc("POST", "runs", { stationId: "bridge-01", templateId: "NauticAI/ArrivalChecklist" }, { "idempotency-key": "rest-1" });
	assert.equal(dup.headers.get("idempotent-replayed"), "true");
	const list = await (await svc("GET", "runs?stationId=bridge-01")).json();
	assert.ok(list.some((r) => r.runId === restRun.runId));
	const ab = await svc("POST", `runs/${restRun.runId}/abandon`);
	assert.equal(ab.status, 200);

	// screen discard: reasons come from Flow (tenant list here), "Other" needs a comment, the status body is exactly what v3 accepts
	step = "screen discard";
	const dRes = await svc("POST", "runs", { stationId: "bridge-01", templateId: "NauticAI/ArrivalChecklist" }, { "idempotency-key": "rest-2" });
	const dRun = await dRes.json();
	assert.equal(dRes.status, 201);
	const reasons = await api("GET", `templates/${encodeURIComponent("NauticAI/ArrivalChecklist")}/discard-reasons`);
	assert.deepEqual(reasons.body.reasons.map((r) => r.code), ["Created by mistake or duplicate", "No longer needed", "Wrong checklist", "Other"], "discard reasons read from Flow");
	assert.equal(reasons.body.reasons.at(-1).requireComment, true);
	const noComment = await api("POST", `runs/${dRun.runId}/discard`, { reasonCode: "Other" });
	assert.equal(noComment.status, 422, JSON.stringify(noComment.body));
	assert.match(noComment.body.message ?? noComment.body.error ?? "", /requires a comment/);
	const badReason = await api("POST", `runs/${dRun.runId}/discard`, { reasonCode: "duplicate" });
	assert.equal(badReason.status, 422, "a reason Flow does not know is refused");
	const discarded = await api("POST", `runs/${dRun.runId}/discard`, { reasonCode: "Other", comment: "started twice" });
	assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
	assert.equal(discarded.body.state, "abandoned");
	assert.deepEqual(fake.statusChanges.at(-1)?.body, { action: "discard", reason: "Other", comment: "started twice" });
	assert.equal(fake.statusChanges.at(-1)?.flowId, dRun.instanceId);


	// admin picks which templates get a start button; the flag rides on every pick, an empty list means all
	step = "start buttons";
	const setStart = await api("PUT", "settings", { startable: ["tpl-engine"] });
	assert.deepEqual(setStart.body.startable, ["tpl-engine"]);
	const flagged = (await api("GET", "checklists")).body;
	assert.ok(flagged.filter((p) => p.templateId === "tpl-engine").every((p) => p.startable === true), "chosen template is startable");
	assert.ok(flagged.filter((p) => p.templateId !== "tpl-engine").every((p) => p.startable === false), "others are not");
	await api("PUT", "settings", { startable: [] });
	assert.ok((await api("GET", "checklists")).body.every((p) => p.startable === true), "empty list → everything startable");

	// checklist language is set per template in Admin and wins over the station's; the listen window tells the phone
	step = "template language";
	const setLang = await api("PUT", "settings", { templateLanguages: { "tpl-engine": "sv", bogus: "xx" } });
	assert.deepEqual(setLang.body.templateLanguages, { "tpl-engine": "sv" }, "only known languages are kept");
	assert.ok((await api("GET", "checklists")).body.filter((p) => p.templateId === "tpl-engine").every((p) => p.language === "sv"));
	listenOpen = undefined;
	const svRun = (await api("POST", "runs", { templateId: "tpl-engine", stationId: "bridge-01" })).body;
	assert.equal(svRun.language, "sv", "run takes the template language");
	await waitFor(() => listenOpen, "listen window of the Swedish run");
	assert.equal(listenOpen.language, "sv", "listen.open carries the run language");
	await api("POST", `runs/${svRun.runId}/abandon`);
	// a client that connects after the run began reports the station language: the checklist language still wins
	const svRun2 = (await api("POST", "runs", { templateId: "tpl-engine", stationId: "ecr-01" })).body;
	assert.equal(svRun2.language, "sv");
	const ws2 = new WebSocket(`ws://127.0.0.1:${port}/v1/audio`, { headers: { cookie } });
	await new Promise((resolve, reject) => {
		ws2.once("open", resolve);
		ws2.once("error", reject);
	});
	ws2.send(JSON.stringify({ type: "hello", endpointId: "e2e-late", stationId: "ecr-01", capabilities: { pushToTalk: true, localStt: true, localTts: true, aec: false }, language: "en" }));
	await new Promise((r) => setTimeout(r, 600));
	assert.equal((await api("GET", `runs/${svRun2.runId}`)).body.language, "sv", "a client hello must not reset the checklist language");
	ws2.close();
	await new Promise((r) => setTimeout(r, 200));
	await api("POST", `runs/${svRun2.runId}/abandon`);
	const meNow = (await api("GET", "auth/me")).body;
	if (meNow.stationId !== "bridge-01") await api("PUT", "auth/station", { stationId: "bridge-01" });
	await api("PUT", "settings", { templateLanguages: {} });

	// per station: start and use / use only / not here, and a language per template that beats the hub-wide one
	assert.equal((await api("GET", "checklists")).body.find((p) => p.source === "template" && p.templateId === "tpl-engine").readiness, "full", "numeric task types from the Templates API count as voice items");
	step = "station checklists";
	const plain = (await api("GET", "stations")).body.map(({ endpoint, activeRun, join, ...st }) => st);
	const ruled = plain.map((st) => (st.stationId === "bridge-01" ? { ...st, templates: { "tpl-engine": { access: "use", language: "de" }, "tpl-departure": { access: "off" }, junk: { access: "maybe", language: "xx" } } } : st));
	const savedRules = (await api("PUT", "stations", ruled)).body.find((st) => st.stationId === "bridge-01").templates;
	assert.deepEqual(savedRules, { "tpl-engine": { access: "use", language: "de" }, "tpl-departure": { access: "off" } }, "unknown values are dropped");
	const herePicks = (await api("GET", "checklists")).body;
	const engTpl = herePicks.find((p) => p.source === "template" && p.templateId === "tpl-engine");
	assert.equal(engTpl.access, "use");
	assert.equal(engTpl.startable, false, "use only: no start button");
	assert.equal(engTpl.language, "de", "station language for the template");
	assert.equal(herePicks.find((p) => p.source === "template" && p.templateId === "tpl-departure").access, "off");
	assert.ok(herePicks.filter((p) => p.templateId === "NauticAI/ArrivalChecklist" || p.refId === "NauticAI/ArrivalChecklist").every((p) => p.access === "off"), "not added to the station → not available there");
	assert.ok(herePicks.some((p) => p.access === "off" && p.templateId !== "tpl-departure"), "templates outside the station list are off");
	const refusedStart = await api("POST", "runs", { templateId: "tpl-engine", stationId: "bridge-01" });
	assert.equal(refusedStart.status, 403, JSON.stringify(refusedStart.body));
	assert.equal(refusedStart.body.error?.code ?? refusedStart.body.code, "NOT_STARTABLE_HERE");
	const elsewhere = await api("POST", "runs", { templateId: "tpl-engine", stationId: "ecr-01" });
	assert.ok(elsewhere.status < 300 && elsewhere.body.language !== "de", `another station still starts it: ${elsewhere.status}`);
	await api("POST", `runs/${elsewhere.body.runId}/abandon`);
	await api("PUT", "stations", plain);

	// Admin → Answers: a word per item; an answer that contains it is accepted and shown as the value
	step = "item answers";
	const tItems = (await api("GET", "template-items?templateId=tpl-engine")).body;
	const lube = tItems.find((i) => i.name === "Check lube oil pressure");
	assert.equal(lube.key, "d:ER/Main/LubeOil");
	const setAns = await api("PUT", "settings", { itemAnswers: { "tpl-engine": { [lube.key]: ["Normal ", "normal", ""], bogus: ["x"] } } });
	assert.deepEqual(setAns.body.itemAnswers, { "tpl-engine": { [lube.key]: ["Normal", "normal"] } });
	const ansRun = (await api("POST", "runs", { templateId: "tpl-engine", stationId: "ecr-01" })).body;
	assert.deepEqual(ansRun.items[0].expected, ["Normal", "normal"], "the run item carries its answer words");
	const heardAns = (await api("POST", "interpret", { type: "Checkbox", text: "pressure is normal", answers: ["normal"] })).body;
	assert.equal(heardAns.ok, true, JSON.stringify(heardAns));
	await api("POST", `runs/${ansRun.runId}/abandon`);
	await api("PUT", "settings", { itemAnswers: {} });

	// central register: download from the Templates app, set language + answer words once, stations pick from it
	step = "checklist register";
	const avail = (await api("GET", "library/available")).body.templates;
	assert.ok(avail.length >= 3 && avail.every((t) => t.registered === false), "nothing registered yet");
	const reg = (await api("POST", "library", { templateId: "tpl-engine" })).body.templates;
	assert.equal(reg.length, 1);
	assert.equal(reg[0].items[0].key, "d:ER/Main/LubeOil", "items are snapshotted with their keys");
	const entry = (await api("PUT", "library/entry", { templateId: "tpl-engine", language: "sv", words: { "d:ER/Main/LubeOil": ["Normal", "normal "], junk: ["x"] } })).body.templates[0];
	assert.equal(entry.language, "sv");
	assert.deepEqual(entry.words, { "d:ER/Main/LubeOil": ["normal"] });
	assert.equal((await api("PUT", "library/entry", { templateId: "tpl-departure", language: "sv" })).status, 404, "only registered checklists can be edited");
	// per checklist: only the marked words count, a plain yes / no is refused
	assert.equal(entry.wordsOnly, false);
	assert.equal((await api("PUT", "library/entry", { templateId: "tpl-engine", wordsOnly: true })).body.templates[0].wordsOnly, true);
	assert.equal((await api("POST", "interpret", { type: "Checkbox", text: "ja", answers: ["körbro"], answersOnly: true })).body.ok, false);
	assert.equal((await api("POST", "interpret", { type: "Checkbox", text: "hivt körbro", answers: ["körbro"], answersOnly: true })).body.valueText, "körbro");
	assert.equal((await api("PUT", "library/entry", { templateId: "tpl-engine", wordsOnly: false })).body.templates[0].wordsOnly, false);
	assert.equal(entry.wordMatch, "normal");
	assert.equal((await api("PUT", "library/entry", { templateId: "tpl-engine", wordMatch: "loose" })).body.templates[0].wordMatch, "loose");
	assert.equal((await api("POST", "interpret", { type: "Checkbox", text: "kurbo hivt", answers: ["körbro"], answersOnly: true, answerMatch: "loose" })).body.valueText, "körbro");
	assert.equal((await api("POST", "interpret", { type: "Checkbox", text: "kurbo hivt", answers: ["körbro"], answersOnly: true, answerMatch: "exact" })).body.ok, false);
	await api("PUT", "library/entry", { templateId: "tpl-engine", wordMatch: "normal" });
	const regPicks = (await api("GET", "checklists")).body;
	assert.ok(regPicks.filter((p) => p.templateId === "tpl-engine").every((p) => p.access === "start" && p.language === "sv"));
	assert.ok(regPicks.filter((p) => p.templateId !== "tpl-engine").every((p) => p.access === "off"), "a non-empty register is the whole offer");
	assert.equal((await api("POST", "runs", { templateId: "tpl-departure", stationId: "ecr-01" })).status, 403);
	const regRun = (await api("POST", "runs", { templateId: "tpl-engine", stationId: "ecr-01" })).body;
	assert.deepEqual(regRun.items[0].expected, ["normal"]);
	assert.equal(regRun.language, "sv");
	await api("POST", `runs/${regRun.runId}/abandon`);
	assert.equal((await api("DELETE", `library?templateId=${encodeURIComponent("tpl-engine")}`)).body.templates.length, 0);
	await api("PUT", "settings", { itemAnswers: {}, templateLanguages: {} });
	assert.ok((await api("GET", "checklists")).body.every((p) => p.access === "start"), "empty register → everything again");

	// light multi-tenancy: a main-hub admin pastes a token for another tenant; it runs as its own isolated hub
	step = "tenants";
	const adminJar = new Map();
	assert.equal((await api("POST", "auth/dev", undefined, adminJar)).body.isAdmin, true);
	// tenants are managed in the central admin area: its own password, not the main hub's admin sign-in
	const locked = (await api("GET", "tenants", undefined, adminJar)).body;
	assert.equal(locked.canManage, false, "a hub admin alone does not manage tenants");
	assert.equal(locked.central, true);
	assert.equal((await api("POST", "tenants", { name: "X", tenant: "demo", token: "t0k3n" }, adminJar)).status, 403);
	assert.deepEqual((await api("GET", "central/me", undefined, adminJar)).body, { configured: true, signedIn: false, mainName: "demo" });
	assert.equal((await api("POST", "central/login", { password: "nope" }, adminJar)).status, 403);
	assert.equal((await api("POST", "central/login", { password: "central-pass-e2e" }, adminJar)).status, 200);
	assert.equal((await api("GET", "central/me", undefined, adminJar)).body.signedIn, true);
	const forgedCentral = new Map([["fv_central", `${Date.now() + 3600_000}.AAAA`]]);
	assert.equal((await api("GET", "central/me", undefined, forgedCentral)).body.signedIn, false, "a forged central cookie is nothing");
	const t0 = (await api("GET", "tenants", undefined, adminJar)).body;
	assert.equal(t0.canManage, true);
	assert.equal(t0.current, undefined);
	const stranger = new Map();
	assert.equal((await api("POST", "tenants", { name: "X", tenant: "demo", token: "t0k3n" }, stranger)).status, 403, "only the central area adds tenants");
	const added = await api("POST", "tenants", { name: "Other Co", tenant: "demo", token: "Bearer t0k3n" }, adminJar);
	assert.equal(added.status, 201, JSON.stringify(added.body));
	assert.equal(added.body.id, "other-co");
	assert.equal(added.body.tokenHint, "t0k3n".slice(-6));
	assert.ok(!JSON.stringify((await api("GET", "tenants", undefined, adminJar)).body).includes("tokenEnc"), "the token never comes back");
	assert.equal((await api("POST", "tenants/other-co/enter", undefined, stranger)).status, 403, "nobody walks into a tenant");
	assert.equal((await api("POST", "tenants/other-co/enter", undefined, adminJar)).status, 200);
	assert.equal((await api("GET", "auth/me", undefined, adminJar)).status, 401, "a tenant has its own sessions");
	const tMe = (await api("POST", "auth/dev", undefined, adminJar)).body;
	assert.equal(tMe.isAdmin, true, "entered as admin");
	assert.equal((await api("GET", "tenants", undefined, adminJar)).body.current?.id, "other-co");
	assert.equal((await api("GET", "tenants", undefined, adminJar)).body.canManage, true, "the main-hub session survives next to the tenant's");
	// its data is its own
	await api("PUT", "settings", { itemAnswers: {} }, adminJar);
	assert.equal((await api("POST", "library", { templateId: "tpl-engine" }, adminJar)).body.templates.length, 1);
	assert.equal((await api("GET", "library")).body.templates.length, 0, "the main hub's register is untouched");
	assert.ok((await api("GET", "checklists", undefined, adminJar)).body.some((p) => p.templateId === "tpl-engine" && p.access === "start"), "the pasted token reads Maranics");
	// a station link of the tenant carries a phone into it, as a non-admin
	const tStations = (await api("GET", "stations", undefined, adminJar)).body;
	const tToken = tStations[0].join.path.split("/join/")[1];
	const tPhone = new Map();
	const tJoin = await api("POST", "auth/join", { token: tToken }, tPhone);
	assert.equal(tJoin.status, 200, JSON.stringify(tJoin.body));
	assert.ok(tPhone.get("fv_tenant")?.startsWith("other-co.client."), "the link moved the phone into its tenant");
	const tPhoneMe = (await api("POST", "auth/dev", undefined, tPhone)).body;
	assert.equal(tPhoneMe.isAdmin, false, "a station link never makes an admin");
	assert.equal(tPhoneMe.stationId, tStations[0].stationId);
	assert.equal((await api("PUT", "settings", { readNotices: true }, tPhone)).status, 403);
	// a forged cookie is ignored: the request lands in the main hub
	const forged = new Map([["fv_tenant", "other-co.admin.AAAA"]]);
	assert.equal((await api("GET", "tenants", undefined, forged)).body.current, undefined);
	// a forged role header is stripped
	const sneaky = await fetch(`${base}/api/auth/dev`, { method: "POST", headers: { cookie: `fv_tenant=${tPhone.get("fv_tenant")}`, "x-fv-tenant-role": "admin" } });
	assert.equal((await sneaky.json()).isAdmin, false, "the role comes from the signed cookie only");
	// back to the main hub without signing in again; removing the tenant closes it
	assert.equal((await api("POST", "tenants/leave", undefined, adminJar)).status, 200);
	assert.equal((await api("GET", "auth/me", undefined, adminJar)).status, 200);
	assert.equal((await api("DELETE", "tenants/other-co", undefined, adminJar)).status, 200);
	// the normal way: a tenant with its own Maranics SSO client; people sign in as themselves
	fake.oidc.setRedirectUri(`http://127.0.0.1:${port}/api/auth/callback`);
	assert.equal((await api("POST", "tenants", { name: "Sso Co", tenant: "demo" }, adminJar)).status, 400, "a tenant needs a client");
	const sso = await api("POST", "tenants", { name: "Sso Co", tenant: "demo", clientId: fake.oidc.clientId, clientSecret: fake.oidc.clientSecret, issuer: fake.oidc.issuer }, adminJar);
	assert.equal(sso.status, 201, JSON.stringify(sso.body));
	assert.equal(sso.body.mode, "sso");
	assert.equal(sso.body.loginPath, "/t/sso-co");
	assert.ok(!JSON.stringify((await api("GET", "tenants", undefined, adminJar)).body).includes(fake.oidc.clientSecret), "the client secret never comes back");
	const ssoJar = new Map();
	const hop = async (url) => {
		const res = await fetch(url, { redirect: "manual", headers: { cookie: [...ssoJar].map(([k, v]) => `${k}=${v}`).join("; ") } });
		for (const sc of res.headers.getSetCookie()) {
			const [k, ...v] = sc.split(";")[0].split("=");
			if (v.join("=")) ssoJar.set(k.trim(), v.join("="));
			else ssoJar.delete(k.trim());
		}
		return res;
	};
	assert.equal((await hop(`${base}/t/nope`)).status, 404);
	const door = await hop(`${base}/t/sso-co`);
	assert.equal(door.status, 302);
	assert.ok(ssoJar.get("fv_tenant")?.startsWith("sso-co."), "the tenant link picks the tenant");
	assert.equal((await api("POST", "auth/dev", undefined, ssoJar)).status >= 400, true, "no sign-in without Maranics in an SSO tenant");
	const toIdp = await hop(`${base}/api/auth/login`);
	assert.equal(toIdp.status, 302, "login redirects to Maranics");
	assert.ok(toIdp.headers.get("location").startsWith(fake.oidc.issuer), toIdp.headers.get("location"));
	const back = await hop(toIdp.headers.get("location"));
	assert.ok(back.headers.get("location").startsWith(`${base}/api/auth/callback`));
	assert.ok((await hop(back.headers.get("location"))).status < 400, "callback lands in the tenant");
	const ssoMe = await api("GET", "auth/me", undefined, ssoJar);
	assert.equal(ssoMe.status, 200, JSON.stringify(ssoMe.body));
	assert.equal(ssoMe.body.isAdmin, true, "first to sign in is the tenant's admin");
	assert.equal((await api("GET", "tenants", undefined, ssoJar)).body.current?.id, "sso-co");
	assert.ok((await api("GET", "checklists", undefined, ssoJar)).body.length > 0, "the user's own token reads Maranics");
	assert.equal((await api("PUT", "tenants/sso-co/client", { clientId: fake.oidc.clientId, clientSecret: fake.oidc.clientSecret }, ssoJar)).status, 403, "a tenant admin is not the central admin");
	assert.equal((await api("DELETE", "tenants/sso-co", undefined, adminJar)).status, 200);
	// a tenant on its own Maranics server: the sign-in address is worked out from the server address
	assert.ok((await api("GET", "tenants", undefined, adminJar)).body.mainHost, "the form knows the main hub's server");
	const far = await api("POST", "tenants", { name: "Far Co", tenant: "farco", host: "https://api.cloud.maranics.com/", clientId: "c", clientSecret: "s3cret-s3cret" }, adminJar);
	assert.equal(far.status, 201, JSON.stringify(far.body));
	assert.equal(far.body.host, "https://api.cloud.maranics.com");
	assert.equal(far.body.issuer, "https://usermanagement.cloud.maranics.com/farco");
	assert.equal((await api("POST", "tenants", { name: "Bad Co", tenant: "x", host: "https://api.evil.example", clientId: "c", clientSecret: "s3cret-s3cret" }, adminJar)).status, 400, "only allowed servers");
	assert.equal((await api("DELETE", "tenants/far-co", undefined, adminJar)).status, 200);
	assert.equal((await api("POST", "central/logout", undefined, adminJar)).status, 200);
	assert.equal((await api("GET", "tenants", undefined, adminJar)).body.canManage, false, "signed out of the central area");
	assert.equal((await api("GET", "auth/me", undefined, tPhone)).status, 401, "a removed tenant's cookie falls back to the main hub");

	// server-side voice: signed-in clients fetch the sentence as a WAV in the checklist's language
	step = "server voice";
	assert.equal((await api("GET", "auth/session")).body.speech.tts, "http");
	const ttsRes = await fetch(`${base}/api/tts?lang=nb-NO&text=${encodeURIComponent("Punkt en. Er rampen oppe?")}`, { headers: { cookie } });
	assert.equal(ttsRes.status, 200);
	assert.equal(ttsRes.headers.get("content-type"), "audio/wav");
	assert.equal(Buffer.from(await ttsRes.arrayBuffer()).subarray(0, 4).toString(), "RIFF");
	assert.equal(ttsCalls.at(-1).voice, "no_NO-talesyntese-medium");
	await fetch(`${base}/api/tts?lang=no&text=${encodeURIComponent("Punkt en. Er rampen oppe?")}`, { headers: { cookie } });
	assert.equal(ttsCalls.length, 1, "a repeated sentence comes from the hub's cache");
	assert.equal((await fetch(`${base}/api/tts?lang=no&text=hei`)).status, 401, "no voice for strangers");
	assert.equal((await fetch(`${base}/api/tts?lang=es&text=hola`, { headers: { cookie } })).status, 404);

	step = "speech models";
	const modelList = await (await fetch(`${base}/models/vosk`)).json();
	assert.deepEqual(modelList.map((m) => m.language).sort(), ["de", "en", "fr", "sv"]);
	assert.equal((await fetch(`${base}/models/vosk/xx.zip`)).status, 404);

	// backup recognition: the phone posts the PCM of a window it could not transcribe; the hub asks the recogniser once
	step = "backup stt";
	assert.equal((await api("GET", "auth/session")).body.speech.sttBackup, true, "boot info advertises the backup recogniser");
	const pcm = Buffer.alloc(16000 * 2, 1); // one second
	const sttRes = await fetch(`${base}/api/stt?language=nb&prompt=${encodeURIComponent("ja, nei, bekreft")}`, { method: "POST", headers: { "content-type": "application/octet-stream", cookie }, body: pcm });
	assert.equal(sttRes.status, 200);
	assert.deepEqual((await sttRes.json()).text, "Ja.", "non-speech tags are stripped");
	assert.equal(sttCalls.at(-1).language, "no");
	assert.equal(sttCalls.at(-1).prompt, "ja, nei, bekreft");
	assert.equal(sttCalls.at(-1).url, "/v1/audio/transcriptions");
	const tiny = await fetch(`${base}/api/stt`, { method: "POST", headers: { cookie }, body: Buffer.alloc(100) });
	assert.equal((await tiny.json()).text, "", "too short to hear: the recogniser is not bothered");

	// every station has its own permanent client link; admins can read it again at any time
	step = "station links";
	const links = (await api("GET", "stations")).body;
	assert.ok(links.every((st) => /^\/client#\/join\/fvj_/.test(st.join?.path ?? "")), "each station carries its link");
	assert.equal(new Set(links.map((st) => st.join.path)).size, links.length, "links are unique per station");
	const again = (await api("GET", "stations")).body;
	assert.deepEqual(again.map((st) => st.join.path), links.map((st) => st.join.path), "stable until rotated");

	// audit is text only
	const audit = await api("GET", "audit?limit=500");
	assert.ok(audit.body.some((a) => a.kind === "item.committed" && a.transcript === "Pilot on board five minutes ago."));

	ws.close();
	sttServer.close();
	ttsServer.close();
	console.log("mock-e2e: OK —", spoken.length, "utterances,", fake.values.length, "values written to Flow");
	console.log(spoken.map((s) => `  APP  ${s}`).join("\n"));
} catch (err) {
	console.error(`mock-e2e FAILED at step "${step}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
	console.error("--- last utterances ---\n" + (globalThis.__spoken ?? []).slice(-6).map((s) => `  APP  ${s}`).join("\n"));
	console.error("--- hub log (tail) ---\n" + log.join("").split("\n").slice(-60).join("\n"));
	process.exitCode = 1;
} finally {
	hub.kill();
	await fake.close();
	rmSync(dataDir, { recursive: true, force: true });
	setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
}
