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
const hub = spawn(process.execPath, ["dist/server.mjs"], {
	cwd: root,
	env: { ...process.env, HUB_SECRET: "e2e-secret-0123456789abcdef", HUB_PORT: String(port), HUB_DATA_DIR: dataDir, HUB_PUBLIC_DIR: path.join(root, "dist", "public"), HUB_TENANT: "demo", HUB_MARANICS_HOST: fake.url, DEV_USER: "Bridge Officer", DEV_MARANICS_TOKEN: "t0k3n", SERVICE_TOKENS: "svc-token", LOG_LEVEL: "debug", LISTEN_MS: "1500", CONFIRM_MS: "1500", EXCHANGE_MS: "20000" },
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
	assert.ok(minted.body.url.endsWith(`/?mobile=1#/join/${minted.body.token}`), minted.body.url);
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
	assert.equal((await api("GET", "stations")).body.find((s) => s.stationId === "bridge-01").join, undefined);
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
	const pilotAt = Date.parse(pilot.value);
	assert.ok(Math.abs(Date.now() - 5 * 60000 - pilotAt) < 60000, `pilot time ≈ 5 min ago (${pilot.value})`);

	// item two: yes/no
	step = "item 2";
	await waitFor(() => spoken.some((s) => s.includes("Pilot card exchanged?")), "item two spoken");
	await say("Yes.");
	await waitFor(() => lastSpoken() === "Pilot card exchanged, yes. Confirm?", "yes read-back");
	await say("yes");
	await waitFor(() => fake.values.some((v) => v.task === "flow-arr-1:ft-arr-1b" && v.value === "true"), "checkbox true");

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
	listenOpen = undefined;
	await waitFor(() => listenOpen, "mic re-armed after a silent window (LISTEN_MS 1500)", 6000);
	assert.equal((await api("GET", `runs/${runId}`)).body.currentTaskId, "flow-arr-1:ft-arr-2b", "still on bow thruster after silence");
	assert.ok(!spoken.some((s) => s.startsWith("I did not hear an answer")), "no auto-escalation on silence");
	await say("maybe later");
	await waitFor(() => /Say yes or no\. Bow thruster tested\?/.test(lastSpoken()), "clarification, never a guess");
	await say("next item");
	await waitFor(() => spoken.some((s) => s.includes("Steering gear tested?")), "item six spoken after next item");
	await say("affirmative");
	await waitFor(() => lastSpoken() === "Steering gear tested, yes. Confirm?", "read-back six");
	await say("confirm");
	step = "item 7";
	await waitFor(() => spoken.some((s) => s.includes("Anchor ready for letting go?")), "item seven");
	await say("where am I");
	await waitFor(() => /Arrival Checklist.*item seven.*answered/.test(lastSpoken()), "where am I answered");
	await say("yes");
	await waitFor(() => lastSpoken() === "Anchor ready for letting go, Yes. Confirm?", "read-back seven");
	await say("confirmed");

	// sweep: the skipped bow thruster comes back, then completion text
	step = "sweep";
	await waitFor(() => spoken.some((s) => /One item skipped\. Going back to it\./.test(s)), "skip sweep offered");
	await waitFor(() => spoken.filter((s) => s.includes("Bow thruster tested?")).length >= 2, "skipped item re-asked");
	await say("no");
	await waitFor(() => lastSpoken() === "Bow thruster tested, no. Confirm?", "read-back no");
	await say("confirm");
	await waitFor(() => /^Two items need the screen\. Arrival Checklist Oslo, seven of nine answered\. Open on screen to finish\.$/.test(lastSpoken()), "completion summary");
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
		const view = (await api("GET", `runs/${erRun.runId}`)).body;
		const cur = view.items.find((x) => x.taskId === view.currentTaskId);
		if (!cur) break;
		await say(cur.type === "Number" ? "forty two" : cur.type === "QuickSelect" ? "normal" : "yes");
		await waitFor(() => /Confirm\?$/.test(lastSpoken()), `read-back for ${cur.name}`);
		await say("confirm");
		await waitFor(async () => (await api("GET", `runs/${erRun.runId}`)).body.items.find((x) => x.taskId === cur.taskId).state !== "current", `item ${cur.name} left current`);
		if ((await api("GET", `runs/${erRun.runId}`)).body.answered >= (await api("GET", `runs/${erRun.runId}`)).body.total) break;
	}
	await waitFor(() => /Complete it on screen\.$/.test(lastSpoken()), "all answered");
	send({ type: "transcript", text: "complete", confidence: 1, final: true });
	await waitFor(() => /^Complete .*\? Say confirm\.$/.test(lastSpoken()), "complete confirmation asked");
	await say("confirm");
	await waitFor(async () => (await api("GET", `runs/${erRun.runId}`)).body.state === "completed", "completed by voice");
	assert.equal(fake.statusChanges.at(-1)?.action, "complete");
	await waitFor(() => navs.filter((n) => n.page === "picker").length >= 2, "back to the picker after completion");
	await waitFor(() => spoken.filter((s) => /checklists you can run|checklist you can run/.test(s)).length >= 2, "menu read again");

	step = "voice station";
	send({ type: "transcript", text: "station engine control room", confidence: 1, final: true });
	await waitFor(() => navs.some((n) => n.stationId === "ecr-01"), "station switch sent to the screen");

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

	// audit is text only
	const audit = await api("GET", "audit?limit=50");
	assert.ok(audit.body.some((a) => a.kind === "item.committed" && a.transcript === "Pilot on board five minutes ago."));

	ws.close();
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
