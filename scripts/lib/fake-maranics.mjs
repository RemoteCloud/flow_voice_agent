/**
 * In-process fake of the Maranics services the FlowDeck hub talks to, for `npm run hub:mock`,
 * `npm run hub:dev` (through scripts/dev-maranics.mjs) and ad-hoc local runs. Pure node:http +
 * node:crypto, no dependencies, works on Windows/macOS/Linux.
 *
 *   Flows API v3 (gateway shape)      /app/flows/v3/flows…
 *   Templates API (api-version 1)     /app/templates/templates… (the gateway maps /app/templates/* onto the service's /api/*)
 *   UserManagement external API       /app/usermanagement/positionTeams  and  /external/api/positionTeams
 *   UserManagement OIDC provider      /um/{tenant}/.well-known/openid-configuration, …/.well-known/jwks,
 *                                     …/connect/authorize, …/connect/token, …/connect/userinfo, …/connect/logout
 *
 * The three APIs require `Authorization: Bearer <token>` — the static `token` option or an
 * unexpired access token issued by the fake provider — and `Tenant: <tenant>`; anything else is
 * 401. The provider auto-approves `fake.oidc.user` (there is no login page): authorization code +
 * PKCE (S256 only), confidential client (`client_id` + `client_secret` in the token request body),
 * RS512 id_tokens signed with a per-process RSA-2048 key published on the JWKS, and rotated,
 * single-use refresh tokens (issued when the scope contains `offline_access`).
 *
 *   import { startFakeMaranics } from "./lib/fake-maranics.mjs";
 *   const fake = await startFakeMaranics({ oidc: { redirectUri: "http://127.0.0.1:8080/api/hub/auth/callback" } });
 *   fake.oidc.issuer                          // http://127.0.0.1:<port>/um/demo  (HUB_OIDC_ISSUER)
 *   fake.oidc.setUser({ position_id: "pos-other", position_name: "Other" });
 *   fake.oidc.denyNext = "access_denied";     // the next authorize answers error=access_denied
 *   fake.oidc.failNextRefresh = true;         // the next refresh_token grant answers invalid_grant
 *   fake.oidc.tokens / refreshTokens / idTokens / refreshCount / authorizeCalls
 *   …
 *   await fake.close();
 */
import { createHash, generateKeyPairSync, randomBytes, sign as signBytes } from "node:crypto";
import http from "node:http";

const T1 = "tpl-engine";
const T2 = "tpl-departure";
const T3 = "NauticAI/ArrivalChecklist";

const NA_OPTIONS = [
	{ title: "Yes", value: "Yes" },
	{ title: "No", value: "No" },
	{ title: "Not applicable", value: "N/A" },
];

/** Template fixtures: engine rounds (Checkbox), pre-departure (mixed), and the spec's Arrival Checklist. */
function templateFixtures() {
	return [
		{
			id: T1,
			name: "Engine Room Rounds",
			refId: "ER-ROUNDS",
			categoryName: "Engine",
			revisionUpdateTime: "2026-08-01T10:00:00Z",
			status: "Active",
			sectionTemplates: [
				{
					id: "sec-er-1",
					name: "Main engines",
					order: 1,
					taskTemplates: [
						{ id: "tt-er-1a", name: "Check lube oil pressure", order: 1, control: { type: "Checkbox", dataId: "ER/Main/LubeOil" } },
						{ id: "tt-er-1b", name: "Check cooling water temp", order: 2, control: { type: "Number", dataId: "ER/Main/CoolingTemp" } },
						{ id: "tt-er-1c", name: "Log running hours", order: 3, control: { type: "Number", dataId: "ER/Main/RunningHours" } },
					],
				},
				{
					id: "sec-er-2",
					name: "Auxiliaries",
					order: 2,
					taskTemplates: [
						{ id: "tt-er-2a", name: "Check generator 1", order: 1, control: { type: "Checkbox", dataId: "ER/Aux/Gen1" } },
						// a checkbox authored with an option ("Title::key"): Flow stores the key, and the v3 flow read hides the list
						{ id: "tt-er-2b", name: "Check generator 2", order: 2, control: { type: "Checkbox", dataId: "ER/Aux/Gen2", values: "Done::completed" } },
						{ id: "tt-er-2c", name: "Check bilge level", order: 3, control: { type: "QuickSelect", dataId: "ER/Aux/Bilge", quickSelectValues: [{ title: "Normal", value: "Normal" }, { title: "High", value: "High" }, { title: "Alarm", value: "Alarm" }] } },
					],
				},
			],
		},
		{
			id: T2,
			name: "Pre-Departure",
			refId: "PRE-DEP",
			categoryName: "Bridge",
			revisionUpdateTime: "2026-08-15T10:00:00Z",
			status: "Active",
			sectionTemplates: [
				{
					id: "sec-pd-1",
					name: "Bridge",
					order: 1,
					taskTemplates: [
						{ id: "tt-pd-1a", name: "Test steering", order: 1, control: { type: "Checkbox", dataId: "PD/Bridge/Steering" } },
						{ id: "tt-pd-1b", name: "Test whistle", order: 2, control: { type: "Checkbox", dataId: "PD/Bridge/Whistle" } },
						{ id: "tt-pd-1c", name: "Record draft", order: 3, requiresValue: true, control: { type: "Number", dataId: "PD/Bridge/Draft" } },
						{ id: "tt-pd-1d", name: "Confirm passenger count", order: 4, control: { type: "Number", dataId: "PD/Bridge/Pax" } },
						{ id: "tt-pd-1e", name: "Master signature", order: 5, control: { type: "Sign", dataId: "PD/Bridge/MasterSign" } },
					],
				},
			],
		},
		{
			id: T3,
			name: "Arrival Checklist",
			refId: "ARR",
			categoryName: "Bridge",
			revisionUpdateTime: "2026-09-01T10:00:00Z",
			status: "Active",
			sectionTemplates: [
				{
					id: "sec-arr-1",
					name: "Pilot operations",
					order: 1,
					taskTemplates: [
						{ id: "tt-arr-1a", name: "Pilot on board", order: 1, control: { type: "DateAndTime", dataId: "NauticAI/ArrivalChecklist/PilotOperations/PilotOnBoard" } },
						{ id: "tt-arr-1b", name: "Pilot card exchanged", order: 2, control: { type: "Checkbox", dataId: "NauticAI/ArrivalChecklist/PilotOperations/PilotCardExchanged" } },
						{ id: "tt-arr-1c", name: "Master pilot exchange completed", order: 3, control: { type: "QuickSelect", dataId: "NauticAI/ArrivalChecklist/PilotOperations/MasterPilotExchange", quickSelectValues: NA_OPTIONS } },
					],
				},
				{
					id: "sec-arr-2",
					name: "Machinery",
					order: 2,
					taskTemplates: [
						{ id: "tt-arr-2a", name: "Main engine started", order: 1, control: { type: "DateAndTime", dataId: "NauticAI/ArrivalChecklist/Machinery/MainEngineStarted" } },
						{ id: "tt-arr-2b", name: "Bow thruster tested", order: 2, control: { type: "Checkbox", dataId: "NauticAI/ArrivalChecklist/Machinery/BowThrusterTested" } },
						{ id: "tt-arr-2c", name: "Steering gear tested", order: 3, control: { type: "Checkbox", dataId: "NauticAI/ArrivalChecklist/Machinery/SteeringGearTested" } },
						{ id: "tt-arr-2d", name: "Anchor ready for letting go", order: 4, control: { type: "QuickSelect", dataId: "NauticAI/ArrivalChecklist/Machinery/AnchorReady", quickSelectValues: NA_OPTIONS } },
					],
				},
				{
					id: "sec-arr-3",
					name: "Sign off",
					order: 3,
					taskTemplates: [
						{ id: "tt-arr-3a", name: "Officer of the watch", order: 1, control: { type: "Sign", dataId: "NauticAI/ArrivalChecklist/SignOff/OOW" } },
						{ id: "tt-arr-3b", name: "Master", order: 2, control: { type: "Sign", dataId: "NauticAI/ArrivalChecklist/SignOff/Master" } },
					],
				},
			],
		},
	];
}

/**
 * Build a flow's tasks from its template: task ids differ from the template task ids, `sectionId`
 * and names match, and the API order is scrambled so ordering by template structure is observable.
 */
function tasksFromTemplate(template, flowId, done = []) {
	const tasks = [];
	for (const s of template.sectionTemplates) {
		for (const t of s.taskTemplates) {
			const control = t.control ?? { type: "Checkbox" };
			const controlId = `${flowId}:${t.id.replace(/^tt-/, "ctl-")}`;
			const isDone = done.includes(t.id);
			tasks.push({
				taskId: `${flowId}:${t.id.replace(/^tt-/, "ft-")}`,
				name: t.name,
				status: isDone ? "Done" : "Open",
				sectionId: s.id,
				requiresValue: !!t.requiresValue,
				order: t.order,
				controls: [{ controlId, dataId: control.dataId, type: control.type, quickSelectValues: control.quickSelectValues, values: control.values }],
				values: isDone ? [{ controlId, dataId: control.dataId, value: control.type === "Checkbox" ? "OK" : control.type === "Number" ? "42" : "done", time: "2026-09-09T05:50:00Z", source: "fixture" }] : [],
			});
		}
	}
	// deterministic scramble: reverse, then move the first to the end
	tasks.reverse();
	tasks.push(tasks.shift());
	return tasks;
}

/** Wire shape of a task in the v3 detail responses (`FlowDto.sections[].tasks[]`, `/tasks`). */
function taskDto(t) {
	const { requiresValue: _rv, ...rest } = t;
	// like the real v3 read: a checkbox's "Title::key" list stays in the template, the flow shows only type + dataId
	rest.controls = rest.controls?.map(({ values: _v, ...c }) => c);
	return { ...rest, state: { status: t.status, processingState: t.status === "Done" ? "Finished" : "Pending", confirmed: t.status === "Done", overridden: false } };
}

function flowDetail(f, template) {
	const sections = (template?.sectionTemplates ?? []).map((s) => ({ sectionId: s.id, name: s.name, order: s.order, status: "Open", tasks: f.tasks.filter((t) => t.sectionId === s.id).map(taskDto), progress: { done: f.tasks.filter((t) => t.sectionId === s.id && t.status === "Done").length, total: f.tasks.filter((t) => t.sectionId === s.id).length } }));
	return { ...flowSummary(f), sections, tasks: f.tasks.map(taskDto) };
}

function flowFixtures(templates) {
	const byId = new Map(templates.map((t) => [t.id, t]));
	const mk = (flowId, name, templateId, createdAt, status, done) => ({
		flowId,
		refId: flowId.toUpperCase(),
		name,
		status,
		templateId,
		createdAt,
		tasks: tasksFromTemplate(byId.get(templateId), flowId, done),
	});
	return [
		mk("flow-er-1", "Engine Room Rounds 06:00", T1, "2026-09-09T06:00:00Z", "Active", ["tt-er-1a", "tt-er-1b"]),
		mk("flow-er-2", "Engine Room Rounds 12:00", T1, "2026-09-09T12:00:00Z", "Active", ["tt-er-1c"]),
		mk("flow-pd-1", "Pre-Departure Bergen", T2, "2026-09-09T09:00:00Z", "Active", []),
		mk("flow-arr-1", "Arrival Checklist Oslo", T3, "2026-09-09T07:00:00Z", "Active", []),
		mk("flow-old", "Engine Room Rounds 00:00", T1, "2026-09-09T00:00:00Z", "Completed", ["tt-er-1a", "tt-er-1b", "tt-er-1c", "tt-er-2a", "tt-er-2b", "tt-er-2c"]),
	];
}

/** Position teams of the UserManagement external API (`HUB_ADMIN_POSITION_TEAMS` resolves against these). */
function positionTeamFixtures() {
	return [
		{ id: "team-ops", name: "FlowDeck operators", positions: ["pos-bridge", "pos-engine"], state: "Active", description: "Bridge and engine officers" },
		{ id: "team-other", name: "Other team", positions: ["pos-other"], state: "Active", description: "Everyone else" },
	];
}

/** The user the fake provider signs in (position `pos-bridge` is in "FlowDeck operators"). */
export const DEFAULT_FAKE_USER = Object.freeze({ sub: "um-user-1", email: "bridge@example.com", name: "Bridge Officer", position_id: "pos-bridge", position_name: "Bridge Officer" });

const KID = "fake-key-1";
const progressOf = (tasks) => ({ done: tasks.filter((t) => t.status === "Done").length, total: tasks.length });
const b64json = (v) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
const hex = (bytes) => randomBytes(bytes).toString("hex");
const nowSec = () => Math.floor(Date.now() / 1000);

function flowSummary(f) {
	return { flowId: f.flowId, refId: f.refId, name: f.name, status: f.status, templateId: f.templateId, createdAt: f.createdAt, progress: progressOf(f.tasks) };
}

function page(items, query) {
	const p = Math.max(1, Number(query.get("page") || 1));
	const size = Math.min(500, Math.max(1, Number(query.get("pageSize") || 50)));
	return { total: items.length, page: p, pageSize: size, items: items.slice((p - 1) * size, p * size) };
}

/**
 * @param {object} [options]
 * @param {string} [options.token]      static bearer accepted by the APIs (besides issued access tokens)
 * @param {string} [options.tenant]     the only tenant; also the issuer path segment
 * @param {number} [options.port]       0 = random
 * @param {object} [options.oidc]       { clientId, clientSecret, redirectUri, accessTtlSec, user }
 * @param {(line: string) => void} [options.log]  one line per request (method, path, status)
 */
export async function startFakeMaranics({ token = "t0k3n", tenant = "demo", port = 0, oidc: oidcOptions = {}, log } = {}) {
	const templates = templateFixtures();
	const flows = flowFixtures(templates);
	const positionTeams = positionTeamFixtures();
	const fixtures = { templates, flows, positionTeams, token, tenant };
	const calls = [];
	const patches = [];
	const creates = [];
	const values = [];
	const statusChanges = [];

	// ---- fake UserManagement OIDC provider: one RSA-2048 key per process, RS512 id_tokens ----
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = publicKey.export({ format: "jwk" });
	const jwks = { keys: [{ kty: "RSA", kid: KID, use: "sig", alg: "RS512", n: jwk.n, e: jwk.e }] };
	const codes = new Map(); // code → { state, nonce, codeChallenge, redirectUri, scope, user, createdAt, used }
	const accessTokens = new Map(); // access token → { sub, exp, user, nonce, scope }
	const refreshTokens = new Map(); // refresh token → { sub, user, nonce, scope, authTime, current }
	/** Live state + knobs; the handlers read it on every request, so late changes take effect at once. */
	const oidc = {
		issuer: "", // set once the port is known
		clientId: oidcOptions.clientId ?? "flowdeck-hub",
		clientSecret: oidcOptions.clientSecret ?? "flowdeck-client-secret-0123456789",
		/** Must match the authorize / token requests byte-exactly; `setRedirectUri()` for late binding. */
		redirectUri: oidcOptions.redirectUri,
		accessTtlSec: oidcOptions.accessTtlSec ?? 3600,
		user: { ...DEFAULT_FAKE_USER, ...(oidcOptions.user ?? {}) },
		/** Every access / refresh / id token ever issued (so a test can assert they never leak). */
		tokens: [],
		refreshTokens: [],
		idTokens: [],
		/** Successful refresh_token grants. */
		refreshCount: 0,
		/** Parsed query of every authorize call. */
		authorizeCalls: [],
		/** `{grant_type, at}` of every token call. */
		tokenCalls: [],
		userinfoCalls: 0,
		/** OAuth error code (e.g. `"access_denied"`) the next authorize answers instead of a code; cleared once used. */
		denyNext: undefined,
		/** The next refresh_token grant answers `invalid_grant` (and revokes that token); cleared once used. */
		failNextRefresh: false,
		setUser(partial) {
			Object.assign(this.user, partial);
			return { ...this.user };
		},
		setRedirectUri(uri) {
			this.redirectUri = uri;
		},
	};
	/** The current profile of a subject: `fake.oidc.user` when it is that subject (so a position change is visible on the next userinfo), else what was captured at issuance. */
	const profileOf = (captured) => (oidc.user.sub === captured.sub ? { ...oidc.user } : { ...captured });
	const signJwt = (claims) => {
		const input = `${b64json({ alg: "RS512", kid: KID, typ: "JWT" })}.${b64json(claims)}`;
		return `${input}.${signBytes("sha512", Buffer.from(input, "ascii"), privateKey).toString("base64url")}`;
	};
	const issueTokens = ({ user, nonce, scope, authTime }) => {
		const u = profileOf(user);
		const iat = nowSec();
		const accessToken = `at_${hex(24)}`;
		accessTokens.set(accessToken, { sub: u.sub, exp: iat + oidc.accessTtlSec, user: u, nonce, scope });
		oidc.tokens.push(accessToken);
		const idToken = signJwt({ iss: oidc.issuer, aud: oidc.clientId, sub: u.sub, email: u.email, name: u.name, tenant, nonce, iat, exp: iat + oidc.accessTtlSec, auth_time: authTime });
		oidc.idTokens.push(idToken);
		const body = { access_token: accessToken, token_type: "Bearer", expires_in: oidc.accessTtlSec, id_token: idToken, scope };
		if (scope.split(/\s+/).includes("offline_access")) {
			const refreshToken = `rt_${hex(24)}`;
			refreshTokens.set(refreshToken, { sub: u.sub, user: u, nonce, scope, authTime, current: true });
			oidc.refreshTokens.push(refreshToken);
			body.refresh_token = refreshToken;
		}
		return body;
	};
	const bearerOf = (req) => {
		const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
		return m ? m[1] : undefined;
	};
	const issuedAccess = (bearer) => {
		const t = bearer ? accessTokens.get(bearer) : undefined;
		return t && t.exp > nowSec() ? t : undefined;
	};
	/** Flows / Templates / positionTeams: the static token or an issued, unexpired access token, plus the tenant header. */
	const apiAuthorized = (req, bearer) => (bearer === token || !!issuedAccess(bearer)) && (req.headers.tenant ?? "") === tenant;

	const json = (res, status, body, headers = {}) => {
		const text = body === undefined ? "" : JSON.stringify(body);
		res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
		res.end(text);
	};
	const problem = (res, status, code, title) => json(res, status, { type: "about:blank", title: title ?? code, status, code });
	const redirect = (res, base, params) => {
		const u = new URL(base);
		for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
		res.writeHead(302, { location: u.toString(), "cache-control": "no-store", "content-length": "0" });
		res.end();
	};
	const readText = (req) =>
		new Promise((resolve) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		});
	const readBody = async (req) => {
		const text = await readText(req);
		try {
			return text ? JSON.parse(text) : undefined;
		} catch {
			return text;
		}
	};

	// ---- OIDC handlers ----
	const discovery = () => ({
		issuer: oidc.issuer,
		authorization_endpoint: `${oidc.issuer}/connect/authorize`,
		token_endpoint: `${oidc.issuer}/connect/token`,
		userinfo_endpoint: `${oidc.issuer}/connect/userinfo`,
		jwks_uri: `${oidc.issuer}/.well-known/jwks`,
		end_session_endpoint: `${oidc.issuer}/connect/logout`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		subject_types_supported: ["public"],
		scopes_supported: ["openid", "email", "profile", "offline_access"],
		token_endpoint_auth_methods_supported: ["client_secret_post"],
		code_challenge_methods_supported: ["S256"],
		id_token_signing_alg_values_supported: ["RS512"],
	});
	const invalidRequest = (res, description) => json(res, 400, { error: "invalid_request", error_description: description }, { "cache-control": "no-store" });

	function authorize(url, res) {
		const q = Object.fromEntries(url.searchParams);
		oidc.authorizeCalls.push(q);
		const scopes = (q.scope ?? "").split(/\s+/).filter(Boolean);
		if (q.client_id !== oidc.clientId) return invalidRequest(res, "unknown client_id");
		if (!oidc.redirectUri || q.redirect_uri !== oidc.redirectUri) return invalidRequest(res, "redirect_uri does not match the registered one");
		if (q.response_type !== "code") return invalidRequest(res, "response_type must be code");
		if (!q.code_challenge || q.code_challenge_method !== "S256") return invalidRequest(res, "a code_challenge with code_challenge_method=S256 is required");
		if (!q.state || !q.nonce) return invalidRequest(res, "state and nonce are required");
		if (!scopes.includes("openid")) return invalidRequest(res, "scope must contain openid");
		if (oidc.denyNext) {
			const error = oidc.denyNext;
			oidc.denyNext = undefined;
			return redirect(res, q.redirect_uri, { error, error_description: `the fake provider was told to answer ${error}`, state: q.state });
		}
		const code = hex(16);
		codes.set(code, { state: q.state, nonce: q.nonce, codeChallenge: q.code_challenge, redirectUri: q.redirect_uri, scope: scopes.join(" "), user: { ...oidc.user }, createdAt: Date.now(), used: false });
		return redirect(res, q.redirect_uri, { code, state: q.state });
	}

	async function tokenEndpoint(req, res) {
		const form = new URLSearchParams(await readText(req));
		const grant = form.get("grant_type") ?? "";
		oidc.tokenCalls.push({ grant_type: grant, at: Date.now() });
		const noStore = { "cache-control": "no-store" };
		if (form.get("client_id") !== oidc.clientId || form.get("client_secret") !== oidc.clientSecret) return json(res, 401, { error: "invalid_client", error_description: "client authentication failed" }, noStore);
		const invalidGrant = (why) => json(res, 400, { error: "invalid_grant", error_description: why }, noStore);
		if (grant === "authorization_code") {
			const c = codes.get(form.get("code") ?? "");
			if (!c) return invalidGrant("unknown authorization code");
			if (c.used) return invalidGrant("code already redeemed");
			c.used = true; // single use, whatever happens next
			if (form.get("redirect_uri") !== c.redirectUri) return invalidGrant("redirect_uri does not match the authorization request");
			const verifier = form.get("code_verifier") ?? "";
			if (!verifier || createHash("sha256").update(verifier, "ascii").digest("base64url") !== c.codeChallenge) return invalidGrant("code_verifier does not match the code_challenge");
			return json(res, 200, issueTokens({ user: c.user, nonce: c.nonce, scope: c.scope, authTime: Math.floor(c.createdAt / 1000) }), noStore);
		}
		if (grant === "refresh_token") {
			const r = refreshTokens.get(form.get("refresh_token") ?? "");
			if (!r) return invalidGrant("unknown refresh token");
			if (!r.current) return invalidGrant("refresh token already rotated");
			r.current = false; // single use: rotated or revoked, whatever happens next
			if (oidc.failNextRefresh) {
				oidc.failNextRefresh = false;
				return invalidGrant("refresh token revoked");
			}
			oidc.refreshCount += 1;
			// the id_token of a refresh reuses the nonce and auth_time of the original sign-in
			return json(res, 200, issueTokens({ user: r.user, nonce: r.nonce, scope: r.scope, authTime: r.authTime }), noStore);
		}
		return json(res, 400, { error: "unsupported_grant_type", error_description: `grant_type ${grant || "(missing)"} is not supported` }, noStore);
	}

	function userinfo(req, res) {
		oidc.userinfoCalls += 1;
		const t = issuedAccess(bearerOf(req));
		if (!t) return json(res, 401, { error: "invalid_token", error_description: "missing, unknown or expired access token" }, { "www-authenticate": 'Bearer error="invalid_token"' });
		const u = profileOf(t.user);
		return json(res, 200, { sub: u.sub, email: u.email, name: u.name, position_id: u.position_id, position_name: u.position_name });
	}

	function logout(url, res) {
		const back = url.searchParams.get("post_logout_redirect_uri");
		if (back) return redirect(res, back, { state: url.searchParams.get("state") ?? undefined });
		const text = "Signed out of the fake UserManagement.";
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text) });
		res.end(text);
	}

	// ---- UserManagement external API ----
	function positionTeamsRoute(url, req, res) {
		if (!url.searchParams.get("api-version") && !req.headers["api-version"]) return problem(res, 400, "API_VERSION_REQUIRED", "api-version is required");
		const onlyActive = url.searchParams.get("onlyActive") === "true";
		const items = positionTeams.filter((t) => !onlyActive || t.state === "Active");
		const p = Math.max(0, Number(url.searchParams.get("page") || 0)); // zero-based
		const size = Math.min(500, Math.max(1, Number(url.searchParams.get("pageSize") || 50)));
		return json(res, 200, { data: items.slice(p * size, (p + 1) * size) }, { "x-total-count": String(items.length) });
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://fake");
		const method = req.method ?? "GET";
		const bearer = bearerOf(req);
		calls.push({ method, path: url.pathname + url.search, at: Date.now(), bearer });
		if (log) res.on("finish", () => log(`${method} ${url.pathname}${url.search} -> ${res.statusCode}`));
		let m;

		// ---- UserManagement OIDC provider (no bearer; the tenant is the issuer's path segment) ----
		if ((m = /^\/um\/([^/]+)(\/.*)$/.exec(url.pathname))) {
			if (decodeURIComponent(m[1]) !== tenant) return problem(res, 404, "TENANT_NOT_FOUND", `no tenant ${m[1]}`);
			const sub = m[2];
			if (method === "GET" && sub === "/.well-known/openid-configuration") return json(res, 200, discovery());
			if (method === "GET" && sub === "/.well-known/jwks") return json(res, 200, jwks);
			if (method === "GET" && sub === "/connect/authorize") return authorize(url, res);
			if (method === "POST" && sub === "/connect/token") return tokenEndpoint(req, res);
			if (method === "GET" && sub === "/connect/userinfo") return userinfo(req, res);
			if (method === "GET" && sub === "/connect/logout") return logout(url, res);
			return problem(res, 404, "NOT_FOUND", `no route for ${method} ${url.pathname}`);
		}

		// ---- everything else: bearer (static token or issued access token) + tenant ----
		if (!apiAuthorized(req, bearer)) return problem(res, 401, "UNAUTHORIZED", "Missing or invalid bearer token / tenant");
		const auth = req.headers.authorization ?? "";

		// ---- Flows API v3 ----
		if (method === "GET" && url.pathname === "/app/flows/v3/flows") {
			const status = url.searchParams.get("status");
			const items = flows.filter((f) => !status || f.status === status || (status === "ActiveAndReady" && f.status === "Active")).map(flowSummary);
			return json(res, 200, page(items, url.searchParams));
		}
		if (method === "POST" && url.pathname === "/app/flows/v3/flows") {
			const body = await readBody(req);
			const template = templates.find((t) => t.id === body?.templateId);
			if (!template) return problem(res, 404, "TEMPLATE_NOT_FOUND", `no template ${body?.templateId}`);
			const flowId = `flow-${hex(4)}`;
			const f = { flowId, refId: flowId.toUpperCase(), name: body.name ?? `${template.name} ${new Date().toISOString().slice(11, 16)}`, status: "Active", templateId: template.id, createdAt: new Date().toISOString(), tasks: tasksFromTemplate(template, flowId) };
			flows.push(f);
			creates.push({ templateId: template.id, flowId, bearer });
			return json(res, 201, flowSummary(f));
		}
		if ((m = /^\/app\/flows\/v3\/flows\/([^/]+)$/.exec(url.pathname)) && method === "GET") {
			const f = flows.find((x) => x.flowId === decodeURIComponent(m[1]));
			if (!f) return problem(res, 404, "FLOW_NOT_FOUND");
			const include = (url.searchParams.get("include") ?? "").toLowerCase();
			return json(res, 200, include.includes("tasks") || include.includes("values") ? flowDetail(f, templates.find((t) => t.id === f.templateId)) : flowSummary(f));
		}
		if ((m = /^\/app\/flows\/v3\/flows\/([^/]+)\/tasks$/.exec(url.pathname)) && method === "GET") {
			const f = flows.find((x) => x.flowId === decodeURIComponent(m[1]));
			if (!f) return problem(res, 404, "FLOW_NOT_FOUND");
			return json(res, 200, page(f.tasks.map(taskDto), url.searchParams));
		}
		if ((m = /^\/app\/flows\/v3\/flows\/([^/]+)\/tasks\/values$/.exec(url.pathname)) && method === "PUT") {
			const body = await readBody(req);
			const f = flows.find((x) => x.flowId === decodeURIComponent(m[1]));
			if (!f) return problem(res, 404, "FLOW_NOT_FOUND");
			if (f.status !== "Active") return problem(res, 409, "FLOW_NOT_ACTIVE", "Flow is not active");
			const items = Array.isArray(body?.items) ? body.items : [];
			if (!items.length) return problem(res, 400, "BAD_REQUEST", "items[] is required");
			const results = items.map((it) => {
				const t = f.tasks.find((x) => x.taskId === it.task || x.controls?.some((c) => c.dataId === it.task));
				if (!t) return { task: it.task, status: 404, code: "TASK_NOT_FOUND" };
				const c = t.controls[0];
				if (c.type === "Sign" || c.type === "Drawing") return { task: it.task, status: 422, code: "CONTROL_NOT_VALUE_BEARING" };
				// real rule (TaskValueValidation.cs): a plain checkbox is "OK" or empty; one with `values` takes the keys of its
				// "Title::key" lines (newline-joined for multi-select); RadioButtons without options is "Yes"/"No"
				const listKeys = c.values ? String(c.values).split("\n").filter(Boolean).map((l) => { const a = l.split("::"); return (a.length > 1 && a[1].trim() ? a[1] : a[0]).trim(); }) : undefined;
				if (c.type === "Checkbox" && !listKeys && String(it.value) !== "OK") return { task: it.task, status: 422, code: "VALUE_INVALID", message: "The submitted value was rejected: it is invalid for this control" };
				if (c.type === "Checkbox" && listKeys && !String(it.value).split("\n").filter(Boolean).every((v) => listKeys.includes(v.trim()))) return { task: it.task, status: 422, code: "VALUE_INVALID", message: "The submitted value was rejected: it is invalid for this control" };
				if (c.type === "RadioButtons" && !c.quickSelectValues && !/^(Yes|No)$/.test(String(it.value))) return { task: it.task, status: 422, code: "VALUE_INVALID", message: "The submitted value was rejected: it is invalid for this control" };
				if (c.type === "Number" && Number.isNaN(Number(it.value))) return { task: it.task, status: 422, code: "VALUE_INVALID", message: "Number expected" };
				if (c.type === "QuickSelect" && c.quickSelectValues && !c.quickSelectValues.some((o) => o.value === String(it.value))) return { task: it.task, status: 422, code: "VALUE_INVALID", message: "value not in the option set" };
				if (t.values.length && !it.overrideExistingValue) return { task: it.task, status: 409, code: "VALUE_OVERWRITE_CONFLICT", message: "value already set — retry with overrideExistingValue=true" };
				t.values = [{ controlId: c.controlId, dataId: c.dataId, value: String(it.value), time: new Date().toISOString(), source: "api" }];
				t.status = "Done"; // a recorded value (including an explicit "no") completes the task
				values.push({ flowId: f.flowId, task: it.task, value: String(it.value), bearer, at: Date.now() });
				return { task: it.task, taskId: t.taskId, controlId: c.controlId, status: 200, value: String(it.value) };
			});
			return json(res, 200, { items: results });
		}
		if ((m = /^\/app\/flows\/v3\/flows\/([^/]+)\/status$/.exec(url.pathname)) && method === "POST") {
			const body = await readBody(req);
			const f = flows.find((x) => x.flowId === decodeURIComponent(m[1]));
			if (!f) return problem(res, 404, "FLOW_NOT_FOUND");
			const action = String(body?.action ?? "").toLowerCase();
			if (action === "complete") {
				if (f.tasks.some((t) => t.status !== "Done" && t.controls[0].type !== "Sign")) return problem(res, 422, "STATE_TRANSITION_INVALID", "open tasks remain");
				f.status = "Completed";
			} else if (action === "discard") f.status = "Discarded";
			else if (action === "reopen") f.status = "Active";
			else return problem(res, 422, "STATE_TRANSITION_INVALID", `unknown action ${action}; valid: complete, discard, reopen`);
			statusChanges.push({ flowId: f.flowId, action, body, bearer });
			return json(res, 200, { flowId: f.flowId, status: f.status });
		}
		if ((m = /^\/app\/flows\/v3\/flows\/([^/]+)\/tasks\/([^/]+)\/state$/.exec(url.pathname)) && method === "PATCH") {
			const body = await readBody(req);
			const flowId = decodeURIComponent(m[1]);
			const taskRef = decodeURIComponent(m[2]);
			patches.push({ flowId, taskRef, body, headers: { authorization: auth, tenant: req.headers.tenant, "content-type": req.headers["content-type"] } });
			const f = flows.find((x) => x.flowId === flowId);
			if (!f) return problem(res, 404, "FLOW_NOT_FOUND");
			if (f.status !== "Active") return problem(res, 409, "FLOW_NOT_ACTIVE", "Flow is not active");
			const t = f.tasks.find((x) => x.taskId === taskRef);
			if (!t) return problem(res, 404, "TASK_NOT_FOUND");
			if (!body || typeof body !== "object" || !body.processingState) return problem(res, 400, "VALIDATION", "processingState is required");
			if (t.requiresValue) return problem(res, 422, "VALUE_INVALID", "This task requires a value");
			if (body.processingState === "Finished") t.status = "Done";
			return json(res, 200, { taskId: t.taskId, state: { status: t.status, processingState: body.processingState, confirmed: t.status === "Done", overridden: false } });
		}

		// ---- Templates API ----
		if (method === "GET" && url.pathname === "/app/templates/templates") {
			// Real templates app: SearchString + SearchInTitle/SearchInRefId flags (no generic `search`).
			const search = (url.searchParams.get("SearchString") ?? "").trim().toLowerCase();
			const inTitle = url.searchParams.get("SearchInTitle") !== "false";
			const inRefId = url.searchParams.get("SearchInRefId") === "true";
			const items = templates.filter((t) => !search || (inTitle && t.name.toLowerCase().includes(search)) || (inRefId && (t.refId ?? "").toLowerCase().includes(search)));
			const p = page(items, url.searchParams);
			return json(
				res,
				200,
				p.items.map(({ sectionTemplates: _s, ...t }) => t),
				{ "x-total-count": String(p.total) },
			);
		}
		if ((m = /^\/app\/templates\/templates\/([^/]+)$/.exec(url.pathname)) && method === "GET") {
			const t = templates.find((x) => x.id === decodeURIComponent(m[1]));
			return t ? json(res, 200, t) : problem(res, 404, "TEMPLATE_NOT_FOUND");
		}

		// ---- UserManagement external API: gateway layout and the `{issuer origin}/external/api` layout the hub derives ----
		if (method === "GET" && (url.pathname === "/app/usermanagement/positionTeams" || url.pathname === "/external/api/positionTeams")) return positionTeamsRoute(url, req, res);

		problem(res, 404, "NOT_FOUND", `no route for ${method} ${url.pathname}`);
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	const host = `http://127.0.0.1:${server.address().port}`;
	oidc.issuer = `${host}/um/${encodeURIComponent(tenant)}`;

	return {
		/** Host base (`http://127.0.0.1:<port>`); the hub derives `/app/flows` and `/app/templates` from it (`HUB_MARANICS_HOST`). */
		url: host,
		host,
		/** Every request: `{method, path, at, bearer}` (`bearer` = the presented token, if any). */
		calls,
		patches,
		creates,
		values,
		statusChanges,
		fixtures,
		/** The fake UserManagement provider: issuer, client registration, knobs and the tokens it issued. */
		oidc,
		setFlowStatus(flowId, status) {
			const f = flows.find((x) => x.flowId === flowId);
			if (!f) throw new Error(`unknown flow ${flowId}`);
			f.status = status;
		},
		setTaskStatus(flowId, taskId, status) {
			const t = flows.find((x) => x.flowId === flowId)?.tasks.find((x) => x.taskId === taskId);
			if (!t) throw new Error(`unknown task ${flowId}/${taskId}`);
			t.status = status;
		},
		/** Add an Active flow of `templateId` (tasks generated from the template unless given). */
		addFlow({ flowId, name, templateId, createdAt = new Date().toISOString(), status = "Active", tasks }) {
			const template = templates.find((t) => t.id === templateId);
			if (!template) throw new Error(`unknown template ${templateId}`);
			const f = { flowId, refId: flowId.toUpperCase(), name: name ?? `${template.name} ${flowId}`, status, templateId, createdAt, tasks: tasks ?? tasksFromTemplate(template, flowId) };
			flows.push(f);
			return flowSummary(f);
		},
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
