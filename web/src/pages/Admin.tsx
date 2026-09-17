import { AnswersTab } from "./AdminAnswers.js";
import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, ChecklistPick, Station, StatusResponse, VoiceProfile, EventMapping } from "../../../server/api.js";
import { api, toApiError } from "../api.js";
import { useApp } from "../context.js";
import { navigate } from "../router.js";
import { StationsTab } from "./AdminStations.js";
import { HubQr } from "./Login.js";
import { versionLine } from "../build.js";

type Tab = "status" | "start" | "answers" | "stations" | "devices" | "profiles" | "outbox" | "audit";

export function AdminPage() {
	const { me } = useApp();
	const [tab, setTab] = useState<Tab>("status");
	const [status, setStatus] = useState<StatusResponse | undefined>();
	const [err, setErr] = useState<string | undefined>();

	const load = useCallback(async () => {
		try {
			setStatus(await api.get<StatusResponse>("status"));
			setErr(undefined);
		} catch (e) {
			setErr(toApiError(e).message);
		}
	}, []);
	useEffect(() => {
		void load();
		const t = window.setInterval(() => void load(), 5000);
		return () => window.clearInterval(t);
	}, [load]);

	const tabs: [Tab, string][] = [
		["status", "Status"],
		["start", "Start buttons"],
		["answers", "Answers"],
		["stations", "Stations"],
		["devices", "Devices & sessions"],
		["profiles", "Profiles & mappings"],
		["outbox", `Outbox${status?.outbox.queued ? ` (${status.outbox.queued})` : ""}`],
		["audit", "Audit"],
	];

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap gap-1">
				{tabs.map(([t, label]) => (
					<button key={t} type="button" className={`btn btn-sm ${tab === t ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab(t)}>
						{label}
					</button>
				))}
				{!me.isAdmin && <span className="ml-auto text-xs text-fg-faint">read-only (not an admin)</span>}
			</div>
			{err && <p className="text-sm text-danger">{err}</p>}
			{!status ? <p className="text-sm text-fg-muted">Loading…</p> : tab === "status" ? <StatusTab s={status} /> : tab === "start" ? <StartTab s={status} reload={load} canEdit={me.isAdmin} /> : tab === "answers" ? <AnswersTab s={status} reload={load} canEdit={me.isAdmin} /> : tab === "stations" ? <StationsTab s={status} reload={load} canEdit={me.isAdmin} /> : tab === "devices" ? <DevicesTab s={status} reload={load} canEdit={me.isAdmin} /> : tab === "profiles" ? <ProfilesTab canEdit={me.isAdmin} /> : tab === "outbox" ? <OutboxTab s={status} reload={load} /> : <AuditTab />}
		</div>
	);
}

function StatusTab({ s }: { s: StatusResponse }) {
	const { boot } = useApp();
	return (
		<div className="grid gap-4 md:grid-cols-2">
			<section className="card">
				<div className="card-head">
					<h2 className="card-title">Hub</h2>
				</div>
				<dl className="card-body kv">
					<dt>Client link</dt>
					<dd>
						<a className="mono underline" href="/client">
							{boot.hubUrl.replace(/\/$/, "")}/client
						</a>{" "}
						<span className="text-fg-faint">— checklists and voice only (PC, Mac, Raspberry Pi, tablet)</span>
					</dd>
					<dt>Admin link</dt>
					<dd>
						<a className="mono underline" href="/admin">
							{boot.hubUrl.replace(/\/$/, "")}/admin
						</a>
					</dd>
					<dt>Version</dt>
					<dd>{versionLine(s.hubVersion)}</dd>
					<dt>Uptime</dt>
					<dd>{Math.round(s.uptimeSec / 60)} min</dd>
					<dt>Speech</dt>
					<dd>
						STT {s.speech.stt}
						{s.speech.sttUrl ? ` (${s.speech.sttUrl})` : ""} · TTS {s.speech.tts}
					</dd>
					<dt>Settings</dt>
					<dd>
						time {s.settings.tzMode} · notices {s.settings.readNotices ? "read" : "silent"} · confirmation {s.settings.confirmation}
					</dd>
					<dt>Outbox</dt>
					<dd>
						{s.outbox.queued} queued · {s.outbox.failed} failed
					</dd>
				</dl>
			</section>
			<section className="card">
				<div className="card-head">
					<h2 className="card-title">Pair the Android app</h2>
				</div>
				<div className="card-body">
					<HubQr hubUrl={boot.hubUrl} compact />
				</div>
			</section>
			<section className="card">
				<div className="card-head">
					<h2 className="card-title">Stations</h2>
				</div>
				<ul className="divide-y divide-line">
					{s.stations.map((st) => (
						<li key={st.stationId} className="px-4 py-2 text-sm">
							<p className="font-medium">
								{st.name} <span className="mono text-xs text-fg-faint">{st.stationId}</span>
							</p>
							<p className="text-xs text-fg-muted">{st.endpoint ? `endpoint ${st.endpoint.endpointId}${st.endpoint.user ? ` as ${st.endpoint.user}` : ""} · ${st.endpoint.observers} observer(s)${st.endpoint.localStt ? " · STT on device" : ""}` : "no endpoint online"}</p>
							{st.activeRun && (
								<button type="button" className="mt-1 text-xs text-accent underline" onClick={() => navigate({ page: "run", id: st.activeRun!.runId })}>
									{st.activeRun.templateName} · {st.activeRun.state} · {st.activeRun.answered}/{st.activeRun.total}
								</button>
							)}
						</li>
					))}
				</ul>
			</section>
			<section className="card md:col-span-2">
				<div className="card-head">
					<h2 className="card-title">Runs & prompts</h2>
				</div>
				<div className="overflow-x-auto">
					<table className="table">
						<thead>
							<tr>
								<th>Run</th>
								<th>Station</th>
								<th>State</th>
								<th>Progress</th>
								<th>Users</th>
							</tr>
						</thead>
						<tbody>
							{s.runs.map((r) => (
								<tr key={r.runId}>
									<td>
										<button type="button" className="text-accent underline" onClick={() => navigate({ page: "run", id: r.runId })}>
											{r.templateName}
										</button>
									</td>
									<td>{r.stationId}</td>
									<td>
										{r.state} / {r.exchange}
									</td>
									<td>
										{r.answered}/{r.total}
										{r.unsynced ? ` (${r.unsynced} unsynced)` : ""}
									</td>
									<td className="text-xs">{r.users.map((u) => u.name ?? u.sub).join(", ")}</td>
								</tr>
							))}
							{s.prompts
								.filter((p) => p.state !== "committed" && p.state !== "cancelled")
								.map((p) => (
									<tr key={p.promptId}>
										<td className="text-fg-muted">prompt: {p.prompt}</td>
										<td>{p.stationId}</td>
										<td>{p.state}</td>
										<td colSpan={2} className="text-xs text-fg-faint">
											{p.createdAt}
										</td>
									</tr>
								))}
							{!s.runs.length && (
								<tr>
									<td colSpan={5} className="text-fg-muted">
										No active runs.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	);
}

/** Which templates get a big start button on the phone / tablet home screen (and a place in the voice menu). Nothing ticked → all of them. */
function StartTab({ s, reload, canEdit }: { s: StatusResponse; reload: () => Promise<void>; canEdit: boolean }) {
	const [templates, setTemplates] = useState<ChecklistPick[] | undefined>();
	const [err, setErr] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		api.get<ChecklistPick[]>("checklists").then(
			(p) => setTemplates(p.filter((x) => x.source === "template")),
			(e) => setErr(toApiError(e).message),
		);
	}, []);
	const chosen = new Set(s.settings.startable ?? []);
	const save = async (ids: string[]) => {
		setBusy(true);
		setErr(undefined);
		try {
			await api.put("settings", { startable: ids });
			await reload();
		} catch (e) {
			setErr(toApiError(e).message);
		} finally {
			setBusy(false);
		}
	};
	const toggle = (id: string) => void save(chosen.has(id) ? [...chosen].filter((x) => x !== id) : [...chosen, id]);
	const langs = s.settings.templateLanguages ?? {};
	const setLang = async (id: string, lang: string) => {
		setBusy(true);
		setErr(undefined);
		try {
			const next = { ...langs };
			if (lang) next[id] = lang;
			else delete next[id];
			await api.put("settings", { templateLanguages: next });
			await reload();
		} catch (e) {
			setErr(toApiError(e).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="card">
			<div className="card-head">
				<div>
					<h2 className="card-title">Start buttons & checklist language</h2>
					<p className="text-xs text-fg-muted">{chosen.size ? `${chosen.size} checklist(s) can be started from the phone / tablet.` : "Nothing ticked: every checklist gets a start button."}</p>
				</div>
				{chosen.size > 0 && (
					<button type="button" className="btn btn-sm" disabled={!canEdit || busy} onClick={() => void save([])}>
						Show all
					</button>
				)}
			</div>
			{err && <p className="px-4 py-2 text-sm text-danger">{err}</p>}
			{!templates ? (
				<p className="card-body text-sm text-fg-muted">Loading checklists…</p>
			) : (
				<ul className="divide-y divide-line">
					{templates.map((t) => (
						<li key={t.templateId}>
							<label className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm">
								<input type="checkbox" className="h-5 w-5" checked={chosen.has(t.templateId)} disabled={!canEdit || busy} onChange={() => toggle(t.templateId)} />
								<span className="min-w-0 flex-1 truncate">{t.templateName}</span>
								<select className="input w-auto py-1 text-xs" value={langs[t.templateId] ?? ""} disabled={!canEdit || busy} onChange={(e) => void setLang(t.templateId, e.target.value)} title="Language the checklist is written in: spoken and recognised in it (English answers are always understood)">
									<option value="">Station language</option>
									<option value="en">English</option>
									<option value="no">Norsk</option>
									<option value="sv">Svenska</option>
									<option value="de">Deutsch</option>
									<option value="fr">Français</option>
								</select>
								<span className="text-xs text-fg-faint">{t.readiness === "full" ? "voice" : t.readiness === "partial" ? "partial voice" : "no voice"}</span>
							</label>
						</li>
					))}
					{!templates.length && <li className="px-4 py-3 text-sm text-fg-muted">No templates visible to this sign-in.</li>}
				</ul>
			)}
		</section>
	);
}

function DevicesTab({ s, reload, canEdit }: { s: StatusResponse; reload: () => Promise<void>; canEdit: boolean }) {
	const [code, setCode] = useState("");
	const [station, setStation] = useState("");
	const [err, setErr] = useState<string | undefined>();
	const approve = async (c: string) => {
		try {
			await api.post("devices/approve", { code: c, stationId: station || undefined });
			setCode("");
			setErr(undefined);
			await reload();
		} catch (e) {
			setErr(toApiError(e).message);
		}
	};
	return (
		<div className="grid gap-4 md:grid-cols-2">
			<section className="card">
				<div className="card-head">
					<h2 className="card-title">Pending enrollments</h2>
				</div>
				<div className="card-body space-y-3">
					{s.pendingEnrollments.map((p) => (
						<div key={p.code} className="flex items-center gap-2">
							<span className="font-mono text-lg tracking-widest">{p.code}</span>
							<span className="flex-1 text-sm text-fg-muted">
								{p.deviceName} ({p.kind})
							</span>
							<button type="button" className="btn btn-sm btn-primary" disabled={!canEdit} onClick={() => void approve(p.code)}>
								Approve
							</button>
						</div>
					))}
					{!s.pendingEnrollments.length && <p className="text-sm text-fg-muted">None. A device requests enrollment from its sign-in screen.</p>}
					<div className="flex gap-2">
						<input className="input" placeholder="Pairing code" value={code} onChange={(e) => setCode(e.target.value)} disabled={!canEdit} />
						<select className="input" value={station} onChange={(e) => setStation(e.target.value)} disabled={!canEdit}>
							<option value="">Any station</option>
							{s.stations.map((st) => (
								<option key={st.stationId} value={st.stationId}>
									{st.name}
								</option>
							))}
						</select>
						<button type="button" className="btn" disabled={!canEdit || code.length < 6} onClick={() => void approve(code)}>
							Approve
						</button>
					</div>
					{err && <p className="text-sm text-danger">{err}</p>}
				</div>
			</section>
			<section className="card">
				<div className="card-head">
					<h2 className="card-title">Enrolled devices</h2>
				</div>
				<ul className="divide-y divide-line">
					{s.devices.map((d) => (
						<li key={d.deviceId} className="flex items-center gap-2 px-4 py-2 text-sm">
							<div className="min-w-0 flex-1">
								<p className={d.revoked ? "line-through" : ""}>
									{d.name} <span className="text-xs text-fg-faint">({d.kind}, {d.tokenHint})</span>
								</p>
								<p className="text-xs text-fg-muted">
									{d.stationId ?? "no station"} · last seen {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never"}
								</p>
							</div>
							{!d.revoked && (
								<button type="button" className="btn btn-sm btn-danger" disabled={!canEdit} onClick={() => void api.del(`devices/${d.deviceId}`).then(reload)}>
									Revoke
								</button>
							)}
						</li>
					))}
					{!s.devices.length && <li className="px-4 py-2 text-sm text-fg-muted">No devices enrolled.</li>}
				</ul>
			</section>
			<section className="card md:col-span-2">
				<div className="card-head">
					<h2 className="card-title">Signed-in sessions</h2>
				</div>
				<div className="overflow-x-auto">
					<table className="table">
						<thead>
							<tr>
								<th>User</th>
								<th>Station</th>
								<th>Token</th>
								<th>Last seen</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{s.sessions.map((x) => (
								<tr key={x.id}>
									<td>{x.name ?? x.sub}</td>
									<td>{x.stationId ?? "—"}</td>
									<td>{x.credential}</td>
									<td className="text-xs">{new Date(x.lastSeenAt).toLocaleString()}</td>
									<td className="text-right">
										<button type="button" className="btn btn-sm btn-danger" disabled={!canEdit} onClick={() => void api.del(`sessions/${x.id}`).then(reload)}>
											Sign out
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	);
}

function ProfilesTab({ canEdit }: { canEdit: boolean }) {
	const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
	const [mappings, setMappings] = useState<EventMapping[]>([]);
	const [pText, setPText] = useState("");
	const [mText, setMText] = useState("");
	const [err, setErr] = useState<string | undefined>();
	const load = useCallback(async () => {
		const [p, m] = await Promise.all([api.get<VoiceProfile[]>("profiles"), api.get<EventMapping[]>("mappings")]);
		setProfiles(p);
		setMappings(m);
		setMText(JSON.stringify(m, null, 2));
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	const saveProfile = async () => {
		try {
			const p = JSON.parse(pText) as VoiceProfile;
			await api.put(`profiles/${encodeURIComponent(p.profileId)}`, p);
			setErr(undefined);
			await load();
		} catch (e) {
			setErr(e instanceof SyntaxError ? `JSON: ${e.message}` : toApiError(e).message);
		}
	};
	const saveMappings = async () => {
		try {
			await api.put("mappings", JSON.parse(mText));
			setErr(undefined);
			await load();
		} catch (e) {
			setErr(e instanceof SyntaxError ? `JSON: ${e.message}` : toApiError(e).message);
		}
	};
	return (
		<div className="grid gap-4 md:grid-cols-2">
			<section className="card">
				<div className="card-head">
					<h2 className="card-title">Voice profiles</h2>
					<span className="text-xs text-fg-faint">One binding per DataId: spoken prompt, phrases (STT bias), confirmation.</span>
				</div>
				<div className="card-body space-y-2">
					<div className="flex flex-wrap gap-2">
						{profiles.map((p) => (
							<button key={p.profileId} type="button" className="btn btn-sm" onClick={() => setPText(JSON.stringify(p, null, 2))}>
								{p.name} ({p.bindings.length})
							</button>
						))}
						<button type="button" className="btn btn-sm btn-ghost" onClick={() => setPText(JSON.stringify({ profileId: "new-profile", name: "New profile", templateId: "", language: "en", bindings: [{ bindingId: "b1", dataId: "", spokenPrompt: "", expect: { type: "Checkbox" }, phrases: [], confirmation: "required" }] }, null, 2))}>
							+ New
						</button>
					</div>
					<textarea className="input mono" rows={16} value={pText} onChange={(e) => setPText(e.target.value)} disabled={!canEdit} placeholder="Select a profile or create one" />
					<button type="button" className="btn btn-primary" onClick={() => void saveProfile()} disabled={!canEdit || !pText}>
						Save profile
					</button>
				</div>
			</section>
			<section className="card">
				<div className="card-head">
					<h2 className="card-title">Event → checklist mappings</h2>
					<span className="text-xs text-fg-faint">Which vessel events start which checklist, on which station.</span>
				</div>
				<div className="card-body space-y-2">
					<textarea className="input mono" rows={16} value={mText} onChange={(e) => setMText(e.target.value)} disabled={!canEdit} />
					<button type="button" className="btn btn-primary" onClick={() => void saveMappings()} disabled={!canEdit}>
						Save mappings
					</button>
					<p className="help">{mappings.length} mapping(s). Triggers arrive on POST /v1/runs/trigger (service token or X-Flow-Signature HMAC).</p>
				</div>
			</section>
			{err && <p className="text-sm text-danger md:col-span-2">{err}</p>}
		</div>
	);
}

function OutboxTab({ s, reload }: { s: StatusResponse; reload: () => Promise<void> }) {
	return (
		<section className="card">
			<div className="card-head">
				<h2 className="card-title">Outbox</h2>
				<button type="button" className="btn btn-sm" onClick={() => void api.post("outbox/retry").then(reload)}>
					Retry failed now
				</button>
			</div>
			<div className="overflow-x-auto">
				<table className="table">
					<thead>
						<tr>
							<th>Created</th>
							<th>Kind</th>
							<th>Instance / task</th>
							<th>User</th>
							<th>State</th>
							<th>Attempts</th>
							<th>Last error</th>
						</tr>
					</thead>
					<tbody>
						{[...s.outbox.entries].reverse().map((o) => (
							<tr key={o.id}>
								<td className="text-xs">{o.createdAt.slice(0, 19).replace("T", " ")}</td>
								<td>{o.kind}</td>
								<td className="mono text-xs">
									{o.instanceId}
									{o.dataId ? ` · ${o.dataId}` : o.taskId ? ` · ${o.taskId}` : ""}
								</td>
								<td className="text-xs">{o.sub}</td>
								<td className={o.state === "failed" ? "text-danger" : o.state === "sent" ? "text-ok" : "text-warn"}>{o.state}</td>
								<td>{o.attempts}</td>
								<td className="text-xs text-fg-muted">{o.lastError ?? ""}</td>
							</tr>
						))}
						{!s.outbox.entries.length && (
							<tr>
								<td colSpan={7} className="text-fg-muted">
									Empty.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function AuditTab() {
	const [rows, setRows] = useState<AuditEntry[]>([]);
	useEffect(() => {
		void api.get<AuditEntry[]>("audit?limit=300").then(setRows);
	}, []);
	return (
		<section className="card">
			<div className="card-head">
				<h2 className="card-title">Audit</h2>
				<span className="text-xs text-fg-faint">Text only: prompt, transcript, value, confidence, user, station, timestamps. Audio is never stored.</span>
			</div>
			<div className="overflow-x-auto">
				<table className="table">
					<thead>
						<tr>
							<th>At</th>
							<th>Kind</th>
							<th>Station</th>
							<th>Item</th>
							<th>Transcript</th>
							<th>Value</th>
							<th>Conf.</th>
							<th>User</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((a, i) => (
							<tr key={i}>
								<td className="text-xs">{a.at.slice(0, 19).replace("T", " ")}</td>
								<td>{a.kind}</td>
								<td>{a.stationId}</td>
								<td className="mono text-xs">{a.dataId ?? a.taskId ?? ""}</td>
								<td className="text-xs italic">{a.transcript ?? a.text ?? ""}</td>
								<td className="text-xs">{a.value ?? ""}</td>
								<td className="text-xs">{a.confidence !== undefined ? `${Math.round(a.confidence * 100)}%` : ""}</td>
								<td className="text-xs">{a.sub ?? ""}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
