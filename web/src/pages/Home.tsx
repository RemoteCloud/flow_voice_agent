import { useCallback, useEffect, useState } from "react";
import type { ChecklistPick, RunView } from "../../../server/api.js";
import { api, credentialErrorText, toApiError } from "../api.js";
import { useApp } from "../context.js";
import { Icon, iconFor } from "../icons.js";
import { useVoice, VoiceBar } from "../voice.js";
import { versionLine } from "../build.js";

const READINESS: Record<ChecklistPick["readiness"], { label: string; cls: string }> = {
	full: { label: "Voice", cls: "border-ok/50 text-ok" },
	partial: { label: "Partial voice", cls: "border-warn/50 text-warn" },
	none: { label: "Not available", cls: "border-line-strong text-fg-faint" },
};
const STATE: Record<ChecklistPick["state"], string> = { not_started: "Not started", in_progress: "In progress", ready_to_complete: "Ready to complete" };
const OPEN_STATES = new Set<RunView["state"]>(["active", "paused", "pending"]);

/**
 * Phone home: the one open run on this station as a big Continue button, then large icon tiles
 * for every checklist. Station chips only when the phone was not locked to a station by QR.
 */
export function HomePage({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
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
	// a run the hub started or moved (voice, trigger) shows up without a manual refresh
	useEffect(() => {
		if (v.run !== undefined) void load();
	}, [v.run, load]);

	const start = async (p: ChecklistPick) => {
		if (!me.stationId) {
			setErr("Pick a station first.");
			return;
		}
		const key = p.instanceId ?? p.templateId;
		setBusy(key);
		setErr(undefined);
		try {
			const run = await api.post<RunView>("runs", { instanceId: p.instanceId, templateId: p.instanceId ? undefined : p.templateId, stationId: me.stationId, runId: p.activeRunId });
			onOpenRun(run.runId);
		} catch (e) {
			setErr(toApiError(e).message);
		} finally {
			setBusy(undefined);
		}
	};

	const open = runs.find((r) => r.stationId === me.stationId && OPEN_STATES.has(r.state));
	const tiles = [...(picks?.filter((p) => p.source === "instance") ?? []), ...(picks?.filter((p) => p.source === "template") ?? [])].filter((p) => !open || p.activeRunId !== open.runId);
	const locked = me.stationSource === "join";
	const station = stations.find((s) => s.stationId === me.stationId);

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-2">
				<VoiceBar compact />
				<button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()} aria-label="Refresh">
					Refresh
				</button>
			</div>
			{(v.transcript || v.error) && (
				<p className="text-sm text-fg-muted">
					{v.transcript && <span className="italic">“{v.transcript}”</span>}
					{v.error && <span className="text-danger"> {v.error}</span>}
				</p>
			)}

			{!locked && stations.length > 1 && (
				<div className="flex flex-wrap gap-2">
					{stations.map((s) => (
						<button key={s.stationId} type="button" className={`btn btn-sm ${me.stationId === s.stationId ? "btn-primary" : ""}`} onClick={() => void setStation(s.stationId).then(load)}>
							{s.location ? `${s.location} · ${s.name}` : s.name}
						</button>
					))}
				</div>
			)}
			{!stations.length && <p className="text-sm text-warn">No station configured on this hub. Set one up in the browser.</p>}
			{stations.length > 0 && !me.stationId && <p className="text-sm text-warn">Pick a station to start a checklist.</p>}

			{open && (
				<button type="button" className="btn btn-primary btn-hero" onClick={() => onOpenRun(open.runId)}>
					<span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent-fg/15">
						<Icon name="play" size={30} strokeWidth={2} />
					</span>
					<span className="min-w-0 flex-1 text-left">
						<span className="block text-xs font-medium tracking-wide uppercase opacity-80">{open.state === "pending" ? "Accept" : open.state === "paused" ? "Resume" : "Continue"}</span>
						<span className="block truncate text-lg leading-tight font-semibold">{open.templateName}</span>
						<span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-accent-fg/25">
							<span className="block h-full rounded-full bg-accent-fg/90" style={{ width: `${open.total ? (open.answered / open.total) * 100 : 0}%` }} />
						</span>
						<span className="mt-1 block text-xs opacity-80">
							{open.answered} of {open.total} answered{open.pendingReason ? ` · ${open.pendingReason}` : ""}
						</span>
					</span>
					<Icon name="chevron" size={22} className="shrink-0 opacity-70" />
				</button>
			)}

			{err && <p className="text-sm text-danger">{err}</p>}
			{picks === undefined ? (
				<p className="text-sm text-fg-muted">Loading checklists…</p>
			) : (
				<div className="grid grid-cols-2 gap-3">
					{tiles.map((p) => {
						const key = p.instanceId ?? p.templateId;
						const r = READINESS[p.readiness];
						const disabled = busy === key || p.readiness === "none";
						return (
							<button key={key} type="button" className="tile" disabled={disabled} onClick={() => void start(p)}>
								<span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 text-accent">
									<Icon name={iconFor(p.templateName)} size={36} strokeWidth={1.6} />
								</span>
								<span className="line-clamp-2 text-base leading-snug font-medium">{p.templateName}</span>
								<span className="text-xs text-fg-muted">
									{busy === key ? "Starting…" : p.source === "template" ? "New" : STATE[p.state]}
									{p.progress ? ` · ${p.progress.done}/${p.progress.total}` : ""}
								</span>
								{p.readiness !== "full" && <span className={`pill ${r.cls}`}>{r.label}</span>}
							</button>
						);
					})}
					{!tiles.length && !open && <p className="col-span-2 text-sm text-fg-muted">Nothing to run{station ? ` on ${station.name}` : ""}.</p>}
				</div>
			)}
			<p className="mt-6 text-center text-[11px] text-fg-faint">{versionLine(boot.hubVersion)}</p>
		</div>
	);
}
