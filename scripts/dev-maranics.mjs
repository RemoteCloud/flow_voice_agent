#!/usr/bin/env node
/**
 * Stand-alone fake Maranics for local development (`npm run dev:maranics`; `npm run dev` starts it
 * by itself unless HUB_OIDC_* points at a real provider): Flows API v3 (with values / create /
 * status), Templates API, UserManagement OIDC provider on one port. Auto-approves one user.
 *
 *   FAKE_PORT          8090
 *   FAKE_REDIRECT_URI  http://127.0.0.1:8443/api/auth/callback   (must equal HUB_OIDC_REDIRECT_URI)
 *   FAKE_CLIENT_ID     flow-voice
 *   FAKE_CLIENT_SECRET dev-client-secret-0123456789
 */
import { startFakeMaranics } from "./lib/fake-maranics.mjs";

const TENANT = process.env.FAKE_TENANT ?? "demo";
const port = Number(process.env.FAKE_PORT ?? 8090);
const redirectUri = process.env.FAKE_REDIRECT_URI ?? "http://127.0.0.1:8443/api/auth/callback";
const clientId = process.env.FAKE_CLIENT_ID ?? "flow-voice";
const clientSecret = process.env.FAKE_CLIENT_SECRET ?? "dev-client-secret-0123456789";

let fake;
try {
	fake = await startFakeMaranics({ port, tenant: TENANT, oidc: { clientId, clientSecret, redirectUri }, log: (line) => console.log(`[dev-maranics] ${line}`) });
} catch (err) {
	console.error(`[dev-maranics] cannot listen on 127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
const u = fake.oidc.user;
console.log(`[dev-maranics] fake Maranics on ${fake.url} (tenant ${TENANT})`);
console.log(`[dev-maranics]   Flows API ${fake.url}/app/flows   Templates API ${fake.url}/app/templates   static token: t0k3n`);
console.log(`[dev-maranics]   OIDC issuer ${fake.oidc.issuer}  client ${clientId} / ${clientSecret}  redirect ${redirectUri}`);
console.log(`[dev-maranics]   signs in ${u.name} <${u.email}> — auto-approved, no password`);
console.log(`[dev-maranics] hub env for this fake:`);
console.log(`[dev-maranics]   HUB_TENANT=${TENANT} HUB_MARANICS_HOST=${fake.url} HUB_OIDC_ISSUER=${fake.oidc.issuer} HUB_PUBLIC_URL=http://127.0.0.1:8443`);
console.log(`[dev-maranics]   HUB_OIDC_CLIENT_ID=${clientId} HUB_OIDC_CLIENT_SECRET=${clientSecret}`);
console.log(`[dev-maranics]   (or, without OIDC: DEV_USER="Bridge Officer" DEV_MARANICS_TOKEN=t0k3n)`);

let closing = false;
const shutdown = () => {
	if (closing) return;
	closing = true;
	fake.close().then(() => process.exit(0));
	setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
