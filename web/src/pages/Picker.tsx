import { useCallback, useEffect, useState } from "react";
import type { ChecklistPick, RunView } from "../../../server/api.js";
import { api, credentialErrorText, toApiError } from "../api.js";
import { useApp } from "../context.js";
import { useVoice, VoiceBar } from "../voice.js";

const READINESS: Record<ChecklistPick["readiness"], { label: string; cls: string }> = {
	full: { label: "Full voice", cls: "border-ok/50 text-ok" },
	partial: { label: "Partial", cls: "border-warn/50 text-warn" },
	none: { label: "Not available", cls: "border-line-strong text-fg-faint" },
};
const STATE: Record<ChecklistPick["state"], string> = {
	not_started: "Not started",
	in_progress: "In progress",
	ready_to_complete: "Ready to complete",
};

/** Browser picker (desktop). Phones use `HomePage`. */
export function PickerPage({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
	const { me, stations, setStation, boot } = useApp();
	const v = useVoice();
	const [picks, setPicks] = useState<ChecklistPick[] | undefined>();
	const [runs, setRuns] = useState<RunView[]>([]);
	const [err, setErr] = useState<string | undefined>();
	const [busy, setBusy] = useState<string | undefined>();

	const load = useCallback(async () => {
		setErr(undefined);
		try {
			const [p, r] = await Promise.all([api.get<ChecklistPick[]>("checklists"), api.get<RunView[]>("runs")]);
			setPicks(p);
			setRuns(r);
		} catch (e) {
			const a = toApiError(e);
			setErr(credentialErrorText(a));
			setPicks([]);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const start = async (p: ChecklistPick) => {
		if (!me.stationId) {
			setErr("Pick a station first.");
			return;
		}
		setBusy(p.instanceId ?? p.templateId);
		setErr(undefined);
		try {
			const run = await api.post<RunView>("runs", {
				instanceId: p.instanceId,
				templateId: p.instanceId ? undefined : p.templateId,
				stationId: me.stationId,
				runId: p.activeRunId,
			});
			onOpenRun(run.runId);
		} catch (e) {
			setErr(toApiError(e).message);
		} finally {
			setBusy(undefined);
		}
	};

	const stationRuns = runs.filter((r) => r.stationId === me.stationId);
	const instances = picks?.filter((p) => p.source === "instance") ?? [];
	const templates = picks?.filter((p) => p.source === "template") ?? [];

	return (
		<div className="space-y-4">
			<section className="card">
				<div className="card-head">
					<h2 className="card-title">Voice</h2>
					<VoiceBar compact />
				</div>
				<div className="card-body text-sm text-fg-muted">
					{v.active ? (
						<>
							Say <strong>list</strong> to hear the checklists, a <strong>name or number</strong> to start one, or <strong>station</strong> followed by a station name. During a run: <strong>next</strong>, <strong>repeat</strong>, <strong>skip</strong>, <strong>pause</strong>, <strong>complete</strong>, <strong>discard</strong>.{v.transcript && <span className="ml-2 italic">“{v.transcript}”</span>}
						</>
					) : (
						<>Start voice to run the app without touching the screen. The hub reads the list and waits for a name.</>
					)}
					{v.error && <p className="mt-1 text-danger">{v.error}</p>}
				</div>
			</section>

			<section className="card">
				<div className="card-head">
					<h2 className="card-title">Station</h2>
					<span className="text-xs text-fg-faint">The station carries the place: language, profile, unattended start.</span>
				</div>
				<div className="card-body flex flex-wrap gap-2">
					{stations.map((s) => (
						<button key={s.stationId} type="button" className={`btn ${me.stationId === s.stationId ? "btn-primary" : ""}`} onClick={() => void setStation(s.stationId).then(load)}>
							{s.name}
						</button>
					))}
					{!stations.length && <p className="text-sm text-fg-muted">No stations configured (Admin → Stations).</p>}
				</div>
			</section>

			{stationRuns.length > 0 && (
				<section className="card">
					<div className="card-head">
						<h2 className="card-title">Active on this station</h2>
					</div>
					<ul className="divide-y divide-line">
						{stationRuns.map((r) => (
							<li key={r.runId} className="flex items-center gap-3 px-4 py-3">
								<div className="min-w-0 flex-1">
									<p className="font-medium">{r.templateName}</p>
									<p className="text-xs text-fg-muted">
										{r.state} · {r.answered}/{r.total} answered
										{r.unsynced ? ` · ${r.unsynced} unsynced` : ""}
										{r.pendingReason ? ` · ${r.pendingReason}` : ""}
									</p>
								</div>
								<button type="button" className="btn btn-primary" onClick={() => onOpenRun(r.runId)}>
									{r.state === "pending" ? "Accept" : "Open"}
								</button>
							</li>
						))}
					</ul>
				</section>
			)}

			<section className="card">
				<div className="card-head">
					<h2 className="card-title">Checklists you can run by voice</h2>
					<button type="button" className="btn btn-sm" onClick={() => void load()}>
						Refresh
					</button>
				</div>
				{err && <p className="px-4 pt-3 text-sm text-danger">{err}</p>}
				{!boot.maranicsConfigured && <p className="px-4 pt-3 text-sm text-warn">Maranics is not configured on this hub (HUB_TENANT, HUB_MARANICS_HOST).</p>}
				{picks === undefined ? (
					<p className="card-body text-sm text-fg-muted">Loading…</p>
				) : (
					<div className="overflow-x-auto">
						<table className="table">
							<thead>
								<tr>
									<th>Checklist</th>
									<th>State</th>
									<th>Voice readiness</th>
									<th className="hidden sm:table-cell">Last activity</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								{instances.map((p) => (
									<Row key={p.instanceId} p={p} busy={busy === p.instanceId} onStart={() => void start(p)} />
								))}
								{templates.length > 0 && (
									<tr>
										<td colSpan={5} className="bg-panel-2 text-xs font-medium tracking-wide text-fg-muted uppercase">
											Start a new checklist
										</td>
									</tr>
								)}
								{templates.map((p) => (
									<Row key={p.templateId} p={p} busy={busy === p.templateId} onStart={() => void start(p)} />
								))}
								{!picks.length && (
									<tr>
										<td colSpan={5} className="text-sm text-fg-muted">
											Nothing to run.
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}

function Row({ p, busy, onStart }: { p: ChecklistPick; busy: boolean; onStart: () => void }) {
	const r = READINESS[p.readiness];
	return (
		<tr>
			<td>
				<p className="font-medium">{p.templateName}</p>
				{p.refId && <p className="mono text-xs text-fg-faint">{p.refId}</p>}
			</td>
			<td className="text-fg-muted">
				{STATE[p.state]}
				{p.progress ? ` ${p.progress.done}/${p.progress.total}` : ""}
			</td>
			<td>
				<span className={`pill ${r.cls}`}>{r.label}</span>
				{p.needsScreen > 0 && p.readiness !== "none" && <span className="ml-2 text-xs text-fg-faint">{p.needsScreen} need the screen</span>}
			</td>
			<td className="hidden text-xs text-fg-faint sm:table-cell">{p.lastActivity ? new Date(p.lastActivity).toLocaleString() : "—"}</td>
			<td className="text-right">
				<button type="button" className="btn btn-primary btn-sm" disabled={busy || p.readiness === "none"} onClick={onStart}>
					{busy ? "…" : p.activeRunId ? "Resume" : p.source === "instance" ? "Run" : "Start"}
				</button>
			</td>
		</tr>
	);
}
