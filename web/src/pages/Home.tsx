import { useCallback, useEffect, useState } from "react";
import type { ChecklistPick, RunView } from "../../../server/api.js";
import { api, credentialErrorText, toApiError } from "../api.js";
import { useApp } from "../context.js";
import { Icon } from "../icons.js";
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
export function HomePage({ onOpenRun, mobile = true }: { onOpenRun: (runId: string) => void; mobile?: boolean }) {
	const { me, stations, boot } = useApp();
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
	const tiles = [...(picks?.filter((p) => p.source === "instance") ?? []), ...(picks?.filter((p) => p.source === "template") ?? [])].filter((p) => p.startable !== false && (!open || p.activeRunId !== open.runId));
	const locked = me.stationSource === "join";
	const canScan = !!window.FlowVoiceAndroid?.scanStation;
	const scan = () => window.FlowVoiceAndroid?.scanStation?.();
	const station = stations.find((s) => s.stationId === me.stationId);

	// every client takes its station from the station link / QR code, never from a control on screen
	if (!locked || !me.stationId) {
		return (
			<div className="flex min-h-[70vh] flex-col items-center justify-center gap-5 text-center">
				<Icon name="qr" size={72} strokeWidth={1.4} />
				<h1 className="text-2xl font-semibold tracking-wide uppercase">{canScan ? "Scan the station QR code" : "Open the station link"}</h1>
				<p className="max-w-sm text-sm text-fg-muted">{canScan ? "This device works on one station, set by the QR poster at that station." : "This client works on one station. Open that station's own link (Admin → Stations), or scan its QR code with a phone or tablet."}</p>
				{canScan && (
					<button type="button" className="start-btn max-w-sm justify-center text-lg font-semibold tracking-wide uppercase" onClick={scan}>
						Scan QR code
					</button>
				)}
				<p className="text-[11px] text-fg-faint">{versionLine(boot.hubVersion)}</p>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-2">
				<VoiceBar compact />
				<div className="flex items-center gap-1">
					{canScan && (
						<button type="button" className="btn btn-sm btn-ghost" onClick={scan}>
							<Icon name="qr" size={14} /> Change station
						</button>
					)}
					<button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()} aria-label="Refresh">
						Refresh
					</button>
				</div>
			</div>
			{(v.transcript || v.error) && (
				<p className="text-sm text-fg-muted">
					{v.transcript && <span className="italic">“{v.transcript}”</span>}
					{v.error && <span className="text-danger"> {v.error}</span>}
				</p>
			)}

			{(me.name || me.locationName) && (
				<p className="text-xs text-fg-faint">
					{me.name}
					{me.locationName ? ` · ${me.locationName}` : ""}
					{me.positionName ? ` · ${me.positionName}` : ""}
				</p>
			)}

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
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{tiles.map((p) => {
						const key = p.instanceId ?? p.templateId;
						const disabled = busy === key || p.readiness === "none";
						return (
							<button key={key} type="button" className="start-btn" disabled={disabled} onClick={() => void start(p)}>
								<span className="min-w-0 flex-1 text-left">
									<span className="line-clamp-2 block text-lg leading-tight font-semibold tracking-wide uppercase">{p.templateName}</span>
									<span className="mt-1 block text-xs tracking-wide text-fg-muted uppercase">
										{busy === key ? "Starting…" : p.source === "template" ? "Start" : STATE[p.state]}
										{p.progress ? ` · ${p.progress.done}/${p.progress.total}` : ""}
										{p.readiness !== "full" ? ` · ${READINESS[p.readiness].label}` : ""}
									</span>
								</span>
								<Icon name="chevron" size={24} className="shrink-0 opacity-60" />
							</button>
						);
					})}
					{!tiles.length && !open && <p className="col-span-full text-sm text-fg-muted">Nothing to run{station ? ` on ${station.name}` : ""}.</p>}
				</div>
			)}
			<p className="mt-6 text-center text-[11px] text-fg-faint">{versionLine(boot.hubVersion)}</p>
		</div>
	);
}
