import assert from "node:assert/strict";
import { EnvError, parseEnv } from "./env.js";

export async function run(): Promise<void> {
	assert.throws(() => parseEnv({}), EnvError, "HUB_SECRET is required");
	assert.throws(() => parseEnv({ HUB_SECRET: "short" }), EnvError);

	const minimal = parseEnv({ HUB_SECRET: "0123456789abcdef0123" }, { cwd: "/srv" });
	assert.equal(minimal.port, 8443);
	assert.equal(minimal.sessionSecret, minimal.secret);
	assert.equal(minimal.maranics, undefined);
	assert.equal(minimal.oidc, undefined);
	assert.ok(minimal.oidcReason);
	assert.equal(minimal.speech.sttMode, "endpoint");
	assert.equal(minimal.policy.tzMode, "utc");
	assert.equal(minimal.policy.listenMs, 8000);

	const full = parseEnv(
		{
			HUB_SECRET: "0123456789abcdef0123",
			SESSION_SECRET: "abcdef0123456789abcd",
			HUB_TENANT: "demo",
			HUB_MARANICS_HOST: "https://api.cloud.preprod.maranics-staging.com/",
			HUB_OIDC_ISSUER: "https://usermanagement.cloud.preprod.maranics-staging.com/demo",
			HUB_OIDC_CLIENT_ID: "flow-voice",
			HUB_OIDC_CLIENT_SECRET: "s3cret-s3cret-s3cret",
			HUB_PUBLIC_URL: "https://flow-voice.vessel.local:8443",
			STT_ENDPOINT: "http://stt:8000",
			SERVICE_TOKENS: "a, b ,",
			WEBHOOK_SECRETS: "elsa=e1,insight=i2",
			WEBHOOK_SECRET: "any",
			TZ_MODE: "local",
			TZ: "Europe/Oslo",
			LOG_LEVEL: "debug",
			DEV_USER: "Bridge Officer",
		},
		{ cwd: "/srv" },
	);
	assert.equal(full.maranics?.flowsBaseUrl, "https://api.cloud.preprod.maranics-staging.com/app/flows");
	assert.equal(full.maranics?.templatesBaseUrl, "https://api.cloud.preprod.maranics-staging.com/app/templates");
	assert.equal(full.maranics?.umApiBaseUrl, "https://usermanagement.cloud.preprod.maranics-staging.com/external/api");
	assert.equal(full.oidc?.redirectUri, "https://flow-voice.vessel.local:8443/api/auth/callback");
	assert.equal(full.oidc?.scopes, "openid email profile offline_access");
	assert.equal(full.speech.sttMode, "http");
	assert.equal(full.speech.sttUrl, "http://stt:8000");
	assert.deepEqual(full.serviceTokens, ["a", "b"]);
	assert.deepEqual(full.webhookSecrets, { elsa: "e1", insight: "i2", "*": "any" });
	assert.equal(full.policy.tzMode, "local");
	assert.equal(full.policy.timeZone, "Europe/Oslo");
	assert.equal(full.logLevel, "debug");
	assert.equal(full.devUser?.sub, "dev:bridge-officer");
	assert.equal(full.devUser?.email, "bridge.officer@example.com");

	const noRedirect = parseEnv({ HUB_SECRET: "0123456789abcdef0123", HUB_TENANT: "demo", HUB_MARANICS_HOST: "http://127.0.0.1:8090", HUB_OIDC_ISSUER: "http://127.0.0.1:8090/um/demo", HUB_OIDC_CLIENT_ID: "x", HUB_OIDC_CLIENT_SECRET: "y" }, { cwd: "/srv" });
	assert.equal(noRedirect.oidc, undefined);
	assert.match(noRedirect.oidcReason ?? "", /HUB_OIDC_REDIRECT_URI or HUB_PUBLIC_URL/);
}
