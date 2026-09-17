/**
 * Flow Voice hub entry point: one process, one port (HTTP + WebSocket + static PWA), one volume.
 *   node dist/server.mjs            (HUB_SECRET, HUB_TENANT, HUB_MARANICS_HOST, HUB_OIDC_*, … see env.ts / README)
 */
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { createLogger } from "./core/log.js";
import { registerSecret } from "./core/redact.js";
import { EnvError, parseEnv, type HubEnv } from "./env.js";
import { ROLE_HEADER, SESSION_COOKIE, Tenants, type Core } from "./tenants.js";
import { createApp, upgradeAuthenticator } from "./http/app.js";
import { OidcAuth } from "./http/auth.js";
import { FlowsClient } from "./maranics/FlowsClient.js";
import { OidcClient } from "./oidc/OidcClient.js";
import { EndpointStt, HttpStt } from "./speech/stt.js";
import { Credentials } from "./store/credentials.js";
import { deriveKey } from "./store/crypto.js";
import { JsonHubStore } from "./store/HubStore.js";
import { Outbox } from "./voice/Outbox.js";
import { RunEngine } from "./voice/RunEngine.js";
import { Gateway } from "./ws/Gateway.js";

export const VERSION = "0.1.0";
/** "0.1.0+04c6827 2026-09-15 20:03Z": the package version plus the build stamp, so a stale deploy is visible in the UI. */
export const HUB_VERSION = `${VERSION}+${typeof __BUILD__ === "string" ? __BUILD__ : "dev"}`;

async function run(): Promise<void> {
	let env;
	try {
		env = parseEnv(process.env);
	} catch (err) {
		if (err instanceof EnvError) {
			console.error(`flow-voice: ${err.message}`);
			process.exit(2);
		}
		throw err;
	}
	registerSecret(env.secret);
	registerSecret(env.sessionSecret);
	registerSecret(env.oidc?.clientSecret);
	registerSecret(env.devToken);
	registerSecret(env.centralPassword);
	for (const t of env.serviceTokens) registerSecret(t);
	const log = createLogger(env.logLevel);
	const now = () => Date.now();
	const startedAt = now();

	/** One isolated hub: its own data folder, sessions, stations, register, runs, outbox and audio gateway. */
	const buildCore = async (env: HubEnv): Promise<Core> => {
		const store = new JsonHubStore(env.dataDir, log);
		const sealKey = deriveKey(env.secret);
		const provider = env.oidc ? new OidcClient(env.oidc, { now, log, tenant: env.maranics?.tenant }) : undefined;
		const credentials = new Credentials({ store, sealKey, provider, maranics: env.maranics, now, log, devToken: env.devToken });
		const auth = new OidcAuth({ store, provider, oidc: env.oidc, tenant: env.maranics?.tenant, sealKey, now, log, unconfiguredReason: env.oidcReason, devUser: env.devUser, tokenTenant: env.tokenTenant });
		const flows = new FlowsClient({ timeoutMs: 10_000 });
		const stt = env.speech.sttMode === "http" && env.speech.sttUrl ? new HttpStt({ url: env.speech.sttUrl, model: env.speech.sttModel, apiKey: env.speech.sttApiKey }, log) : new EndpointStt();
		const sttBackup = env.speech.sttBackupUrl ? new HttpStt({ url: env.speech.sttBackupUrl, model: env.speech.sttBackupModel, apiKey: env.speech.sttApiKey, timeoutMs: 20000 }, log) : undefined;
		const gateway = new Gateway({
			log,
			hubVersion: HUB_VERSION,
			stt,
			sttBackup,
			now,
			authenticate: upgradeAuthenticator({ env, store, now }),
			onEndpointChange: (stationId, endpointId) => log.debug(`station ${stationId}: endpoint ${endpointId ?? "none"}`),
			bindStation: async (session, stationId, deviceId) => {
				await store.update((d) => {
					const s = d.sessions.find((x) => x.id === session.id);
					if (s) {
						s.stationId = stationId;
						s.deviceId = deviceId;
					}
					const dev = deviceId ? d.devices.find((x) => x.deviceId === deviceId) : undefined;
					if (dev) {
						dev.stationId = stationId;
						dev.lastSeenAt = new Date(now()).toISOString();
					}
				});
				session.stationId = stationId;
			},
		});
		let engine: RunEngine;
		const outbox = new Outbox({
			store,
			flows,
			credentials,
			log,
			now,
			onChange: (entry, outcome) => {
				void engine?.onOutboxChange(entry.runId, entry.id, outcome, entry.lastError);
				gateway.emit({ type: "outbox.changed", at: new Date(now()).toISOString(), runId: entry.runId, taskId: entry.taskId, text: outcome });
			},
		});
		engine = new RunEngine({ store, flows, credentials, outbox, log, now, policy: env.policy, io: gateway, vesselId: env.vesselId });
		gateway.attachEngine(engine);
		const app = createApp({ env, store, auth, credentials, engine, outbox, gateway, stt, sttBackup, log, version: HUB_VERSION, now, uptime: () => (now() - startedAt) / 1000 });
		await engine.recover();
		outbox.start();
		gateway.start();
		return {
			fetch: (req) => app.fetch(req),
			handleUpgrade: (req, socket, head) => gateway.handleUpgrade(req, socket, head),
			store,
			stop: () => {
				outbox.stop();
				gateway.stop();
			},
		};
	};

	const main = await buildCore(env);
	const tenants = new Tenants({ env, store: main.store, sealKey: deriveKey(env.secret), log, now, main, build: buildCore });
	await tenants.start();
	const tenantApi = tenants.app();

	// A token tenant keeps its own session cookie, so entering one never signs the admin out of the main hub.
	const sessionRe = (name: string) => new RegExp(`(^|;\\s*)${name}=`);
	const cookiesFor = (cookie: string, id: string | undefined): string => {
		const parts = cookie.split(/;\s*/).filter(Boolean);
		if (!id) return parts.filter((p) => !p.startsWith(`${SESSION_COOKIE}_`)).join("; ");
		return parts
			.filter((p) => !p.startsWith(`${SESSION_COOKIE}=`))
			.map((p) => (p.startsWith(`${SESSION_COOKIE}_${id}=`) ? `${SESSION_COOKIE}=${p.slice(`${SESSION_COOKIE}_${id}=`.length)}` : p))
			.join("; ");
	};
	const dispatch = async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		if (url.pathname === "/api/tenants" || url.pathname.startsWith("/api/tenants/") || url.pathname.startsWith("/api/central/") || /^\/t\/[^/]+$/.test(url.pathname)) return tenantApi.fetch(req);
		let picked = tenants.pick(req.headers.get("cookie"));
		let tenantCookie: string | undefined;
		if (req.method === "POST" && url.pathname === "/api/auth/join") {
			// a station link belongs to exactly one tenant: find it, and move this browser there
			const body = (await req.clone().json().catch(() => ({}))) as { token?: unknown };
			const owner = typeof body.token === "string" ? tenants.coreOfJoinToken(body.token) : undefined;
			if (owner && owner.id !== picked.id) {
				picked = { core: owner.core, id: owner.id, role: owner.id ? "client" : undefined };
				tenantCookie = tenants.setCookie(owner.id, "client");
			}
		}
		const headers = new Headers(req.headers);
		headers.delete(ROLE_HEADER);
		if (picked.role) headers.set(ROLE_HEADER, picked.role);
		const cookie = cookiesFor(req.headers.get("cookie") ?? "", picked.id);
		if (cookie) headers.set("cookie", cookie);
		else headers.delete("cookie");
		const res = await picked.core.fetch(new Request(req, { headers }));
		if (!picked.id && !tenantCookie) return res;
		const out = new Headers(res.headers);
		const set = res.headers.getSetCookie();
		out.delete("set-cookie");
		for (const sc of set) out.append("set-cookie", picked.id && sessionRe(SESSION_COOKIE).test(sc) && sc.startsWith(`${SESSION_COOKIE}=`) ? `${SESSION_COOKIE}_${picked.id}=${sc.slice(SESSION_COOKIE.length + 1)}` : sc);
		if (tenantCookie) out.append("set-cookie", tenantCookie);
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
	};

	const server = serve({ fetch: dispatch, hostname: env.host, port: env.port, createServer }, (info) => {
		log.info(`Flow Voice hub ${HUB_VERSION} listening on http://${info.address}:${info.port} (data ${env.dataDir}, public ${env.publicDir})`);
		log.info(`Maranics: ${env.maranics ? `${env.maranics.host} tenant ${env.maranics.tenant}` : "NOT configured (HUB_TENANT + HUB_MARANICS_HOST)"}; sign-in: ${env.oidc ? env.oidc.issuer : env.devUser ? `dev user "${env.devUser.name}"` : "not configured"}`);
		log.info(`speech: STT ${env.speech.sttMode}${env.speech.sttUrl ? ` (${env.speech.sttUrl})` : " (on the endpoint)"}, TTS ${env.speech.ttsMode}${env.speech.sttBackupUrl ? `, backup STT ${env.speech.sttBackupUrl}` : ""}`);
	});
	(server as unknown as import("node:http").Server).on("upgrade", (req, socket, head) => {
		const picked = tenants.pick(req.headers.cookie);
		req.headers.cookie = cookiesFor(req.headers.cookie ?? "", picked.id);
		void picked.core.handleUpgrade(req, socket as import("node:stream").Duplex, head).then((handled) => {
			if (!handled) {
				socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
				socket.destroy();
			}
		});
	});

	const shutdown = (signal: string) => {
		log.info(`${signal}: shutting down`);
		main.stop();
		tenants.stop();
		(server as unknown as import("node:http").Server).close(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000).unref();
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
