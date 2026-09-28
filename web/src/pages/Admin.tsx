import { ChecklistsTab } from "./AdminChecklists.js";
import { TenantsTab } from "./AdminTenants.js";
import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, ChecklistPick, LibraryView, Station, StatusResponse, VoiceProfile, EventMapping } from "../../../server/api.js";
import { api, toApiError } from "../api.js";
import { useApp } from "../context.js";
import { navigate } from "../router.js";
import { StationsTab } from "./AdminStations.js";
import { HubQr } from "./Login.js";
import { versionLine } from "../build.js";
import { Alert, EXCHANGE_TEXT, joinNames, plural, RUN_STATE_TEXT } from "../components/ui.js";
import type { RunState } from "../../../server/protocol.js";

type Tab = "status" | "checklists" | "tenants" | "stations" | "devices" | "profiles" | "outbox" | "audit";
const TABS: Tab[] = ["status", "checklists", "stations", "devices", "profiles", "outbox", "audit", "tenants"];

/** The tab lives in the address (#/admin/stations), so a refresh, the back button and a pasted link land on the same screen. */
export function AdminPage({ tab: wanted }: { tab?: string }) {
	const { me } = useApp();
	const tab: Tab = TABS.includes(wanted as Tab) ? (wanted as Tab) : "status";
	const setTab = (t: Tab) => navigate({ page: "admin", tab: t });
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
		["checklists", "Checklist setup"],
		["stations", "Stations"],
		["devices", "Devices & sessions"],
		["profiles", "Advanced (JSON)"],
		["outbox", `Outbox${status?.outbox.queued ? ` (${status.outbox.queued})` : ""}`],
		["audit", "Audit"],
		["tenants", "Tenants"],
	];

	return (
		<div className="space-y-4">
			<nav className="flex flex-wrap gap-1" aria-label="Admin sections">
				{tabs.map(([t, label]) => (
					<button key={t} type="button" className={`btn btn-sm ${tab === t ? "btn-primary" : "btn-ghost"}`} aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
						{label}
					</button>
				))}
				{!me.isAdmin && <span className="ml-auto self-center text-xs text-fg-faint">Read-only: you are not an admin</span>}
			</nav>
			{err && <Alert title="The hub could not be reached">{err}</Alert>}
			{!status ? <p className="text-sm text-fg-muted">Loading…</p> : tab === "status" ? <StatusTab s={status} go={setTab} /> : tab === "checklists" ? <ChecklistsTab canEdit={me.isAdmin} /> : tab === "stations" ? <StationsTab s={status} reload={load} canEdit={me.isAdmin} /> : tab === "devices" ? <DevicesTab s={status} reload={load} canEdit={me.isAdmin} /> : tab === "profiles" ? <ProfilesTab canEdit={me.isAdmin} /> : tab === "tenants" ? <TenantsTab /> : tab === "outbox" ? <OutboxTab s={status} reload={load} /> : <AuditTab />}
		</div>
	);
}

/** Three steps from an empty hub to a working station; each shows whether it is done and jumps to the right tab. */
function SetupGuide({ s, go }: { s: StatusResponse; go: (t: Tab) => void }) {
	const [downloaded, setDownloaded] = useState<number | undefined>();
	useEffect(() => {
		api.get<LibraryView>("library").then((l) => setDownloaded(l.templates.length), () => setDownloaded(undefined));
	}, []);
	const words = Object.values(s.settings.itemAnswers ?? {}).reduce((n, per) => n + Object.keys(per).length, 0);
	const inUse = s.stations.filter((st) => st.endpoint).length;
	const steps: { done: boolean; title: string; text: string; button: string; tab: Tab }[] = [
		{ done: !!downloaded, title: "Download checklists", text: downloaded ? `${downloaded} downloaded from Maranics.` : "Pick the checklists to use from the Maranics Templates app.", button: "Checklist setup", tab: "checklists" },
		{ done: words > 0, title: "Set language and answer words", text: words ? `${plural(words, "item")} with answer words.` : "Optional: tap the words that count as the answer, like UP for Ramp.", button: "Checklist setup", tab: "checklists" },
		{ done: inUse > 0, title: "Open a station", text: inUse ? `${plural(inUse, "station")} in use now.` : "Each station has its own link and QR code. Scan it with the tablet.", button: "Stations", tab: "stations" },
	];
	return (
		<section className="card md:col-span-2">
			<div className="card-head">
				<h2 className="card-title">Set up in three steps</h2>
			</div>
			<ol className="grid gap-px bg-line md:grid-cols-3">
				{steps.map((st, i) => (
					<li key={st.title} className="flex flex-col gap-2 bg-panel p-4">
						<p className="flex items-center gap-2 text-sm font-semibold">
							<span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs ${st.done ? "border-ok text-ok" : "border-line-strong text-fg-muted"}`}>{st.done ? "✓" : i + 1}</span>
							{st.title}
						</p>
						<p className="flex-1 text-xs text-fg-muted">{st.text}</p>
						<button type="button" className={`btn btn-sm self-start ${st.done ? "" : "btn-primary"}`} onClick={() => go(st.tab)}>
							{st.button}
						</button>
					</li>
				))}
			</ol>
		</section>
	);
}

function StatusTab({ s, go }: { s: StatusResponse; go: (t: Tab) => void }) {
	const { boot } = useApp();
	return (
		<div className="grid gap-4 md:grid-cols-2">
			<SetupGuide s={s} go={go} />
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
					<dt>Running for</dt>
					<dd>{s.uptimeSec >= 5400 ? `${Math.round(s.uptimeSec / 3600)} h` : `${Math.round(s.uptimeSec / 60)} min`}</dd>
					<dt>Speech</dt>
					<dd>
						Hears {s.speech.stt === "endpoint" ? "on each device" : `on the hub${s.speech.sttUrl ? ` (${s.speech.sttUrl})` : ""}`} · speaks {s.speech.tts === "endpoint" ? "with the device's own voice" : "with the hub's voice"}
					</dd>
					<dt>Read-back</dt>
					<dd>
						{s.settings.confirmation === "required" ? "Every answer is read back and confirmed" : "Answers are read back only when the hub is unsure"} · times in {String(s.settings.tzMode).toUpperCase()} · notices {s.settings.readNotices ? "read aloud" : "not read aloud"}
					</dd>
					<dt>Waiting to sync</dt>
					<dd>
						{s.outbox.queued ? <span className="text-warn">{plural(s.outbox.queued, "answer")} on the way to Flow</span> : "Nothing"}
						{s.outbox.failed ? (
							<>
								{" · "}
								<button type="button" className="text-danger underline" onClick={() => go("outbox")}>
									{s.outbox.failed} failed
								</button>
							</>
						) : ""}
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
							<p className="text-xs text-fg-muted">
								{st.endpoint ? (
									<>
										<span className="text-ok">● In use</span>
										{st.endpoint.user ? ` by ${st.endpoint.user}` : ""}
										{st.endpoint.observers ? ` · ${plural(st.endpoint.observers, "other screen")} watching` : ""}
									</>
								) : (
									"No device connected"
								)}
							</p>
							{st.activeRun && (
								<button type="button" className="mt-1 text-xs text-accent underline" onClick={() => navigate({ page: "run", id: st.activeRun!.runId })}>
									{st.activeRun.templateName} · {(RUN_STATE_TEXT[st.activeRun.state as RunState] ?? st.activeRun.state).toLowerCase()} · {st.activeRun.answered} of {st.activeRun.total}
								</button>
							)}
						</li>
					))}
				</ul>
			</section>
			<section className="card md:col-span-2">
				<div className="card-head">
					<h2 className="card-title">Checklists running now</h2>
					<span className="text-xs text-fg-faint">Click one to open it.</span>
				</div>
				<div className="overflow-x-auto">
					<table className="table">
						<thead>
							<tr>
								<th>Run</th>
								<th>Station</th>
								<th>State</th>
								<th>Answered</th>
								<th>Who</th>
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
									<td>{s.stations.find((st) => st.stationId === r.stationId)?.name ?? r.stationId}</td>
									<td>
										{RUN_STATE_TEXT[r.state]}
										{EXCHANGE_TEXT[r.exchange] ? <span className="text-fg-faint"> · {EXCHANGE_TEXT[r.exchange]}</span> : null}
									</td>
									<td>
										{r.answered} of {r.total}
										{r.unsynced ? <span className="text-warn"> · {r.unsynced} not yet in Flow</span> : ""}
									</td>
									<td className="text-xs">{joinNames(r.users)}</td>
								</tr>
							))}
							{s.prompts
								.filter((p) => p.state !== "committed" && p.state !== "cancelled")
								.map((p) => (
									<tr key={p.promptId}>
										<td className="text-fg-muted">Question: {p.prompt}</td>
										<td>{s.stations.find((st) => st.stationId === p.stationId)?.name ?? p.stationId}</td>
										<td>{p.state}</td>
										<td colSpan={2} className="text-xs text-fg-faint">
											{p.createdAt}
										</td>
									</tr>
								))}
							{!s.runs.length && (
								<tr>
									<td colSpan={5} className="text-fg-muted">
										Nothing is running right now.
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
			<Alert tone="info" className="md:col-span-2">
				For integrators. Everyday setup lives under Checklist setup and Stations; nothing here is needed to run a checklist by voice.
			</Alert>
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
			{err && <Alert className="md:col-span-2">{err}</Alert>}
		</div>
	);
}

function OutboxTab({ s, reload }: { s: StatusResponse; reload: () => Promise<void> }) {
	return (
		<section className="card">
			<div className="card-head">
				<div>
					<h2 className="card-title">Outbox</h2>
					<p className="text-xs text-fg-faint">Answers on their way to Flow. Failed ones are retried on their own; "Retry now" does it at once.</p>
				</div>
				<button type="button" className="btn btn-sm" disabled={!s.outbox.failed && !s.outbox.queued} onClick={() => void api.post("outbox/retry").then(reload)}>
					Retry now
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
									Nothing waiting. Every answer has reached Flow.
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
	const [rows, setRows] = useState<AuditEntry[] | undefined>();
	const [q, setQ] = useState("");
	const load = useCallback(() => api.get<AuditEntry[]>("audit?limit=300").then(setRows, () => setRows([])), []);
	useEffect(() => {
		void load();
	}, [load]);
	const needle = q.trim().toLowerCase();
	const shown = (rows ?? []).filter((a) => !needle || [a.kind, a.stationId, a.dataId, a.taskId, a.transcript, a.text, a.value, a.sub].some((f) => f && String(f).toLowerCase().includes(needle)));
	return (
		<section className="card">
			<div className="card-head">
				<div>
					<h2 className="card-title">Audit</h2>
					<p className="text-xs text-fg-faint">What was asked, what was heard and what was written, by whom and when. Audio is never stored.</p>
				</div>
				<div className="flex items-center gap-2">
					<input className="input w-56 py-1 text-xs" placeholder="Filter (station, user, word…)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter the audit list" />
					<button type="button" className="btn btn-sm" onClick={() => void load()}>
						Refresh
					</button>
				</div>
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
						{shown.map((a, i) => (
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
						{rows && !shown.length && (
							<tr>
								<td colSpan={8} className="text-fg-muted">
									{rows.length ? "Nothing matches the filter." : "Nothing recorded yet."}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</section>
	);
}
