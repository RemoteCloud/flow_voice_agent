/**
 * Flow Voice hub entry point: one process, one port (HTTP + WebSocket + static PWA), one volume.
 *   node dist/server.mjs            (HUB_SECRET, HUB_TENANT, HUB_MARANICS_HOST, HUB_OIDC_*, … see env.ts / README)
 */
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { createLogger } from "./core/log.js";
import { registerSecret } from "./core/redact.js";
import { EnvError, parseEnv } from "./env.js";
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

async function main(): Promise<void> {
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
	for (const t of env.serviceTokens) registerSecret(t);
	const log = createLogger(env.logLevel);
	const now = () => Date.now();
	const startedAt = now();

	const store = new JsonHubStore(env.dataDir, log);
	const sealKey = deriveKey(env.secret);
	const provider = env.oidc ? new OidcClient(env.oidc, { now, log, tenant: env.maranics?.tenant }) : undefined;
	const credentials = new Credentials({ store, sealKey, provider, maranics: env.maranics, now, log, devToken: env.devToken });
	const auth = new OidcAuth({ store, provider, oidc: env.oidc, tenant: env.maranics?.tenant, sealKey, now, log, unconfiguredReason: env.oidcReason, devUser: env.devUser });
	const flows = new FlowsClient({ timeoutMs: 10_000 });
	const stt = env.speech.sttMode === "http" && env.speech.sttUrl ? new HttpStt({ url: env.speech.sttUrl, model: env.speech.sttModel, apiKey: env.speech.sttApiKey }, log) : new EndpointStt();

	const gateway = new Gateway({
		log,
		hubVersion: VERSION,
		stt,
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

	const app = createApp({ env, store, auth, credentials, engine, outbox, gateway, stt, log, version: VERSION, now, uptime: () => (now() - startedAt) / 1000 });

	await engine.recover();
	outbox.start();
	gateway.start();

	const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port, createServer }, (info) => {
		log.info(`Flow Voice hub ${VERSION} listening on http://${info.address}:${info.port} (data ${env.dataDir}, public ${env.publicDir})`);
		log.info(`Maranics: ${env.maranics ? `${env.maranics.host} tenant ${env.maranics.tenant}` : "NOT configured (HUB_TENANT + HUB_MARANICS_HOST)"}; sign-in: ${env.oidc ? env.oidc.issuer : env.devUser ? `dev user "${env.devUser.name}"` : "not configured"}`);
		log.info(`speech: STT ${env.speech.sttMode}${env.speech.sttUrl ? ` (${env.speech.sttUrl})` : " (on the endpoint)"}, TTS ${env.speech.ttsMode}`);
	});
	(server as unknown as import("node:http").Server).on("upgrade", (req, socket, head) => {
		void gateway.handleUpgrade(req, socket as import("node:stream").Duplex, head).then((handled) => {
			if (!handled) {
				socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
				socket.destroy();
			}
		});
	});

	const shutdown = (signal: string) => {
		log.info(`${signal}: shutting down`);
		outbox.stop();
		gateway.stop();
		(server as unknown as import("node:http").Server).close(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000).unref();
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
