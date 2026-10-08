import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunView } from "../../../server/api.js";
import type { HubEvent, RunItem } from "../../../server/protocol.js";
import { api, toApiError } from "../api.js";
import { useApp } from "../context.js";
import { Icon } from "../icons.js";
import { navigate } from "../router.js";
import { LanguageSelect, STATE_TEXT, useVoice, type VoiceApi } from "../voice.js";
import { Alert, joinNames, RUN_STATE_TEXT } from "../components/ui.js";
import { BleButtonLink } from "../components/BleButtonLink.js";

/** `mobile` (the Android agent): current item, mic, the few run buttons, items behind a toggle. No typed input, no hands-free switch, no event log. */
export function RunPage({ runId, mobile = false }: { runId: string; mobile?: boolean }) {
	const { me, boot, stations } = useApp();
	const v = useVoice();
	const [run, setRun] = useState<RunView | undefined>();
	const [err, setErr] = useState<string | undefined>();
	const [manual, setManual] = useState<RunItem | undefined>();
	const [discardOpen, setDiscardOpen] = useState(false);

	const load = useCallback(async () => {
		try {
			setRun(await api.get<RunView>(`runs/${encodeURIComponent(runId)}`));
		} catch (e) {
			setErr(toApiError(e).message);
		}
	}, [runId]);
	useEffect(() => {
		void load();
	}, [load]);

	// live updates arrive through the voice session's socket
	useEffect(() => {
		if (v.run && v.run.runId === runId) setRun(v.run);
		else if (v.run === null) void load();
	}, [v.run, runId, load]);

	const station = stations.find((s) => s.stationId === (run?.stationId ?? me.stationId));
	const voice = v.state;
	const voiceText = v.stateText;
	const transcript = v.transcript;
	const events = v.events;
	const handsFree = v.handsFree;
	const startVoice = useCallback(() => v.start(run?.stationId), [v, run?.stationId]);

	const act = async (path: string, body?: unknown) => {
		setErr(undefined);
		try {
			setRun(await api.post<RunView>(`runs/${encodeURIComponent(runId)}/${path}`, body));
		} catch (e) {
			setErr(toApiError(e).message);
		}
	};

	const current = useMemo(() => run?.items.find((i) => i.taskId === run.currentTaskId), [run]);
	const sections = useMemo(() => {
		const out: { name: string | undefined; items: RunItem[] }[] = [];
		for (const i of run?.items ?? []) {
			const last = out[out.length - 1];
			if (last && last.name === i.sectionName) last.items.push(i);
			else out.push({ name: i.sectionName, items: [i] });
		}
		return out;
	}, [run]);

	if (!run)
		return err ? (
			<Alert title="This checklist could not be opened">
				{err}{" "}
				<button type="button" className="underline" onClick={() => navigate({ page: "picker" })}>
					Back to checklists
				</button>
			</Alert>
		) : (
			<p className="text-sm text-fg-muted">Loading run…</p>
		);
	const done = run.state === "completed" || run.state === "abandoned";
	const completeBlocked = done ? undefined : run.unsynced > 0 ? `${run.unsynced} answer${run.unsynced > 1 ? "s are" : " is"} still on the way to Flow.` : run.answered < run.total ? `${run.total - run.answered} item${run.total - run.answered > 1 ? "s are" : " is"} still open.` : undefined;
	const progressParts = [`${run.answered} of ${run.total} answered`, run.needsScreen ? `${run.needsScreen} need the screen` : "", run.skipped ? `${run.skipped} skipped` : "", run.unsynced ? `${run.unsynced} waiting to sync` : ""].filter(Boolean);
	const controls = { run, v, station, done, current, mobile, act, startVoice, onManual: () => current && setManual(current), onError: setErr, reload: () => void load() };

	return (
		<div className={`grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] ${mobile ? "pb-32" : ""}`}>
			<div className="space-y-4">
				{/* current item */}
				<section className="card">
					<div className="card-head">
						<div>
							<h1 className="card-title">{run.templateName}</h1>
								<p className="text-xs text-fg-muted">
									{station?.name ?? run.stationId} · {RUN_STATE_TEXT[run.state]}
									{run.pendingReason ? ` · ${run.pendingReason}` : ""}
									{run.users.length ? ` · ${joinNames(run.users)}` : ""}
								</p>
								{run.recording && (
									<p className="mt-1 flex items-center gap-1.5 text-xs text-danger" title="Answers on this station are recorded with the checklist item to improve speech recognition.">
										<span aria-hidden className="inline-block h-2 w-2 rounded-full bg-danger" />
										Answers are recorded for training
									</p>
								)}
						</div>
						<span className={`pill max-w-full ${voice === "listening" ? "border-danger text-danger" : voice === "speaking" ? "border-accent text-accent" : voice === "ready" ? "border-ok/50 text-ok" : "border-line-strong text-fg-muted"}`}>
							<span className="truncate">
								{STATE_TEXT[voice]}
								{voiceText ? ` · ${voiceText}` : ""}
							</span>
						</span>
					</div>
					<div className="card-body">
						<div className="mb-3 h-1.5 overflow-hidden rounded bg-panel-2">
							<div
								className="h-full bg-ok transition-all"
								style={{
									width: `${run.total ? (run.answered / run.total) * 100 : 0}%`,
								}}
							/>
						</div>
							<p className="text-xs text-fg-muted">{progressParts.join(" · ")}</p>
						{run.state === "pending" ? (
							<div className="mt-4">
								<p className="text-lg">{run.pendingReason}</p>
								<button
									type="button"
									className="btn btn-primary btn-lg mt-3"
									onClick={() =>
										void api
											.post<RunView>("runs", {
												runId: run.runId,
												stationId: run.stationId,
												templateId: run.templateId,
											})
											.then(setRun, (e) => setErr(toApiError(e).message))
									}
								>
									Start
								</button>
							</div>
						) : current ? (
							<div className="mt-4">
								<p className="text-xs tracking-wide text-fg-faint uppercase">
									{current.sectionName ? `${current.sectionName} · ` : ""}Item {current.index}
								</p>
								<p className="mt-1 text-2xl font-semibold leading-snug sm:text-3xl">{current.spokenPrompt}</p>
								<p className="mt-1 text-sm text-fg-muted">
									{current.type}
									{current.options ? `: ${current.options.map((o) => o.title).join(" · ")}` : ""}
								</p>
							</div>
						) : run.waiting ? (
							<div className="mt-4">
								<p className="text-xs tracking-wide text-fg-faint uppercase">Up next</p>
								<p className="mt-1 text-lg text-fg-muted">{run.items.find((i) => i.taskId === run.waiting?.taskId)?.name}</p>
								<p className="mt-2 text-sm text-fg-muted">
									{run.waiting.mode === "ask" ? "Say \"next\" or press Next item." : run.waiting.mode === "timer" ? <Countdown until={run.waiting.until} /> : "Waiting for another system to go on. \"Next\" or the button also works."}
								</p>
									{!mobile && (
										<button type="button" className="btn btn-primary mt-3" onClick={() => void act("proceed")}>
											Next item
										</button>
									)}
								</div>
							) : (
								<p className="mt-4 text-lg text-fg-muted">{done ? (run.state === "completed" ? "Checklist completed." : "Run stopped. The checklist stays open in Flow.") : run.state === "paused" ? "Paused." : run.answered >= run.total ? "All items answered. Complete the checklist below." : "Waiting for the next item…"}</p>
						)}
						{run.pendingReadback && (
							<div className="mt-4 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2">
								<p className="text-xs tracking-wide text-accent uppercase">Read-back</p>
								<p className="text-lg">
									{current?.name}, <strong>{run.pendingReadback.valueText}</strong>. Confirm?
								</p>
								<p className="text-xs text-fg-muted">
									heard: “{run.pendingReadback.transcript}” · {Math.round(run.pendingReadback.confidence * 100)}%
								</p>
									{!mobile && (
										<div className="mt-2 flex gap-2">
											<button type="button" className="btn btn-primary" onClick={() => void act("answer", { transcript: "confirm" })}>
												Confirm
											</button>
											<button type="button" className="btn" onClick={() => void act("answer", { transcript: "no" })}>
												No
											</button>
										</div>
									)}
							</div>
						)}
						{(transcript || run.transcript) && <p className="mt-3 text-sm text-fg-muted italic">“{transcript || run.transcript}”</p>}
						{run.lastSpoken && <p className="mt-2 text-xs text-fg-faint">Hub: {run.lastSpoken}</p>}
					</div>
				</section>

					{/* voice controls: a card on a PC, a bar fixed to the bottom of the screen on a phone / tablet */}
					{!mobile && (
						<section className="card">
							<div className="card-body">
								<VoiceControls {...controls} />
								{(err || v.error) && <Alert className="mt-3">{err ?? v.error}</Alert>}
								<p className="help mt-3">
									{handsFree ? "Hands-free: the mic opens after every question and stays open between items. " : "Push-to-talk: hold the button, or hold Space. "}
									Speech is recognised {boot.speech.stt === "endpoint" ? "on this device" : "on the hub"}; the voice comes from this device.
									{boot.speech.stt !== "endpoint" ? " Hands-free needs on-device recognition." : ""}
								</p>
							</div>
						</section>
					)}
					{mobile && (err || v.error) && <Alert>{err ?? v.error}</Alert>}

					{/* checklist actions */}
					<section className="card">
						<div className="card-body flex flex-wrap items-center gap-2">
							<button type="button" className="btn btn-primary" disabled={done || !!completeBlocked} onClick={() => void act("complete")} title={completeBlocked ?? "Complete the checklist in Flow"}>
								Complete checklist
							</button>
							{mobile && run.state === "active" && (
								<button type="button" className="btn" onClick={() => void act("pause")}>
									Pause
								</button>
							)}
							{mobile && run.state === "paused" && (
								<button type="button" className="btn btn-primary" onClick={() => void act("resume")}>
									Resume
								</button>
							)}
							{mobile && run.voiceModeCrew && !done && <VoiceModeButton run={run} onError={setErr} onDone={() => void load()} />}
							<button type="button" className="btn btn-danger" disabled={done} onClick={() => setDiscardOpen(true)}>
								Discard…
							</button>
							<button
								type="button"
								className="btn btn-ghost"
								disabled={done}
								onClick={() => {
									if (confirm("Stop this run? Answers already given stay in Flow, and the checklist can be continued later.")) void act("abandon");
								}}
							>
								Stop run
							</button>
							{mobile && v.active && (
								<button type="button" className="btn btn-ghost" onClick={() => v.stop()}>
									Voice off
								</button>
							)}
							<BleButtonLink buttons={stations.find((s) => s.stationId === run.stationId)?.buttons} className="btn" />
							<button type="button" className={`btn ml-auto gap-1 pl-2 ${mobile ? "h-12 text-base" : ""}`} onClick={() => navigate({ page: "picker" })}>
								<Icon name="chevron" size={20} className="rotate-180" />
								Back to checklists
							</button>
						</div>
						{completeBlocked && !done && <p className={`px-4 pb-3 text-xs ${run.unsynced ? "text-warn" : "text-fg-muted"}`}>Complete is not possible yet: {completeBlocked}</p>}
					</section>
			</div>

			{/* item list, ECAM style; first on a phone, right-hand column on a tablet */}
			<section className="card order-first overflow-hidden md:order-none">
				<div className="card-head">
					<h2 className="card-title">
						Items <span className="ml-1 font-normal text-fg-muted">{run.answered}/{run.total}</span>
					</h2>
						<span className="text-xs text-fg-faint">{mobile ? "Tap an item to type its answer." : "Tap an item to type its answer; ▶ reads it next."}</span>
				</div>
				<ItemList run={run} sections={sections} mobile={mobile} done={done} onManual={setManual} onJump={(taskId) => void act(`items/${encodeURIComponent(taskId)}/jump`)} />
				{!mobile && events.length > 0 && (
					<div className="border-t border-line px-4 py-2">
						<p className="text-xs font-medium tracking-wide text-fg-muted uppercase">Events</p>
						<ul className="mt-1 space-y-0.5 text-xs text-fg-faint">
							{events.slice(0, 8).map((e, k) => (
								<li key={k} className="truncate">
									{e.at.slice(11, 19)} {e.type}
									{e.text ? ` — ${e.text}` : ""}
								</li>
							))}
						</ul>
					</div>
				)}
			</section>

			{manual && (
				<ManualDialog
					item={manual}
					onClose={() => setManual(undefined)}
					onSubmit={(value, valueText) =>
						act(`items/${encodeURIComponent(manual.taskId)}/answer`, {
							value,
							valueText,
						}).then(() => setManual(undefined))
					}
				/>
			)}
				{mobile && (
					<div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-bg/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur">
						<VoiceControls {...controls} />
					</div>
				)}
				{discardOpen && <DiscardDialog templateId={run.templateId} onClose={() => setDiscardOpen(false)} onSubmit={(reasonCode, comment) => act("discard", { reasonCode, comment }).then(() => setDiscardOpen(false))} />}
		</div>
	);
}

type ControlsProps = { run: RunView; v: VoiceApi; station?: { name: string }; done: boolean; current?: RunItem; mobile: boolean; act: (path: string, body?: unknown) => Promise<void>; startVoice: () => Promise<void>; onManual: () => void; onError: (m: string | undefined) => void; reload: () => void };

/**
 * The mic and the few buttons a crew member needs while a checklist runs. On a phone / tablet this sits in a bar
 * at the bottom of the screen, always under the thumb; on a PC it is a card with the extra desktop switches.
 * While a read-back waits, Confirm / No take the place of Repeat / Skip so the answer is one tap away.
 */
function VoiceControls({ run, v, station, done, current, mobile, act, startVoice, onManual, onError, reload }: ControlsProps) {
	const listening = v.state === "listening";
	const readback = run.pendingReadback;
	const [typed, setTyped] = useState("");
	if (v.state === "disconnected")
		return (
			<button type="button" className="btn btn-primary btn-lg w-full" onClick={() => void startVoice()} disabled={done}>
				Start voice on {station?.name ?? run.stationId}
			</button>
		);
	if (v.role === "observer")
		return (
			<div className="flex flex-wrap items-center justify-center gap-3 text-center">
				<p className="text-sm text-fg-muted">Another device holds the microphone on this station.</p>
				<button type="button" className="btn" onClick={() => v.takeover()}>
					Take over
				</button>
			</div>
		);
	const ptt = (
		<button
			type="button"
			className={`${mobile ? "h-16 min-w-0 flex-1 rounded-2xl border-2 text-base" : "h-32 w-32 rounded-full border-4 text-lg"} flex items-center justify-center font-semibold select-none ${listening ? "mic-ring border-danger bg-danger/20 text-danger" : "border-accent bg-accent/10 text-accent active:bg-accent/30"}`}
			onPointerDown={(e) => {
				e.preventDefault();
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
				v.pttStart();
			}}
			onPointerUp={() => v.pttEnd()}
			onPointerCancel={() => v.pttEnd()}
			onContextMenu={(e) => e.preventDefault()}
			aria-pressed={listening}
			disabled={done}
		>
			{listening ? "Listening…" : v.state === "speaking" ? "Speaking…" : "Hold to talk"}
		</button>
	);
	const secondary = readback ? (
		<>
			<button type="button" className={`btn btn-primary ${mobile ? "h-16 px-5 text-base" : ""}`} onClick={() => void act("answer", { transcript: "confirm" })}>
				Confirm
			</button>
			<button type="button" className={`btn ${mobile ? "h-16 px-5 text-base" : ""}`} onClick={() => void act("answer", { transcript: "no" })}>
				No
			</button>
		</>
	) : run.waiting ? (
		<button type="button" className={`btn btn-primary ${mobile ? "h-16 px-5 text-base" : ""}`} onClick={() => void act("proceed")}>
			Next item
		</button>
	) : (
		<>
			<button type="button" className={`btn ${mobile ? "h-16 px-4" : ""}`} onClick={() => void act("repeat")} disabled={done || !current}>
				Repeat
			</button>
			<button type="button" className={`btn ${mobile ? "h-16 px-4" : ""}`} onClick={() => void act("skip", { reason: "skipped on screen" })} disabled={done || !current}>
				Skip
			</button>
		</>
	);
	if (mobile)
		return (
			<div className="flex items-stretch gap-2">
				{ptt}
				{secondary}
			</div>
		);
	return (
		<div className="flex flex-col items-center gap-3">
			{ptt}
			<div className="flex flex-wrap justify-center gap-2">
				{secondary}
				<button type="button" className="btn" onClick={onManual} disabled={done || !current}>
					Type the answer
				</button>
				{run.state === "active" ? (
					<button type="button" className="btn" onClick={() => void act("pause")}>
						Pause
					</button>
				) : run.state === "paused" ? (
					<button type="button" className="btn btn-primary" onClick={() => void act("resume")}>
						Resume
					</button>
				) : null}
				<button type="button" className="btn btn-ghost" onClick={() => v.stop()}>
					Voice off
				</button>
				{run.voiceModeCrew && <VoiceModeButton run={run} onError={onError} onDone={reload} />}
				<LanguageSelect />
			</div>
			<label className="flex items-center gap-2 text-sm">
				<input type="checkbox" checked={v.handsFree} onChange={(e) => v.setHandsFree(e.target.checked)} disabled={!v.handsFreeSupported} />
				Hands-free (open mic between items: say “next”, “repeat”, “pause”, “complete”, “discard”, or answer unprompted)
			</label>
			<form
				className="flex w-full gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (!typed.trim()) return;
					if (v.role === "endpoint" && v.active) v.sayText(typed);
					else void act("answer", { transcript: typed });
					setTyped("");
				}}
			>
				<input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type what you would say (e.g. “five minutes ago”, “confirm”, “skip”)" />
				<button type="submit" className="btn">
					Send
				</button>
			</form>
		</div>
	);
}

/** Sectioned list: answered rows carry a check, the current row is highlighted, upcoming rows stay muted. On phones it scrolls with the page and follows the current item. */
/** What the two ways of answering are called on the run screen. The admin allowed the crew to switch between them. */
const VOICE_MODES: { mode: "prompt" | "trigger" | "both"; label: string; help: string }[] = [
	{ mode: "prompt", label: "Asked one by one", help: "The hub reads an item and waits for your answer." },
	{ mode: "trigger", label: "You say the words", help: "The hub stays quiet. Say the words of an item to set it, in any order." },
	{ mode: "both", label: "Both", help: "The hub reads item by item and the words work at any time." },
];

/** One button that steps through the three ways of answering; it changes the station, so the whole bridge follows. */
function VoiceModeButton({ run, onError, onDone }: { run: RunView; onError: (m: string | undefined) => void; onDone: () => void }) {
	const [busy, setBusy] = useState(false);
	const at = Math.max(0, VOICE_MODES.findIndex((m) => m.mode === run.voiceMode));
	const now = VOICE_MODES[at];
	const next = VOICE_MODES[(at + 1) % VOICE_MODES.length];
	return (
		<button
			type="button"
			className="btn"
			disabled={busy}
			title={`${now.help} Tap for: ${next.label}.`}
			onClick={async () => {
				setBusy(true);
				onError(undefined);
				try {
					await api.put(`stations/${encodeURIComponent(run.stationId)}/voice-mode`, { mode: next.mode });
					onDone();
				} catch (e) {
					onError(toApiError(e).message);
				} finally {
					setBusy(false);
				}
			}}
		>
			{now.label}
		</button>
	);
}

function ItemList({ run, sections, mobile, done, onManual, onJump }: { run: RunView; sections: { name: string | undefined; items: RunItem[] }[]; mobile: boolean; done: boolean; onManual: (item: RunItem) => void; onJump: (taskId: string) => void }) {
	useEffect(() => {
		if (!run.currentTaskId) return;
		document.getElementById(`item-${run.currentTaskId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [run.currentTaskId]);
	const counts = (items: RunItem[]) => {
		const total = items.filter((i) => i.state !== "info").length;
		const answered = items.filter((i) => i.state === "answered" || i.state === "unsynced").length;
		return total ? `${answered}/${total}` : "";
	};
	return (
		<div className="ecam max-h-[46vh] overflow-x-hidden overflow-y-auto pb-3 md:max-h-[78vh]">
			{sections.map((s, si) => (
				<div key={si}>
					{s.name && (
						<p className="ecam-title">
							<span className="min-w-0 truncate">{s.name}</span>
							<span className="shrink-0 font-normal text-fg-muted">{counts(s.items)}</span>
						</p>
					)}
					<ul>
						{s.items.map((i) => {
							const isNow = i.state === "current" || (i.state === "unanswered" && i.taskId === run.currentTaskId && !done);
							const tone = isNow ? "ecam-now" : i.state === "answered" ? "ecam-done" : i.state === "unsynced" || i.state === "skipped" || i.state === "needs_screen" ? "ecam-attn" : i.state === "info" ? "ecam-info" : "ecam-todo";
							return (
								<li key={i.taskId} id={`item-${i.taskId}`} className="flex items-stretch">
									<button type="button" className={`ecam-row ${tone}`} onClick={() => onManual(i)} disabled={done || i.state === "info"}>
										<span className="ecam-name">{i.name}</span>
										{i.state !== "info" && <span className="ecam-dots" aria-hidden="true" />}
										{i.state !== "info" && <span className="ecam-value">{ecamValue(i)}</span>}
									</button>
									{i.voice && !done && !isNow && run.state === "active" && (
										<button type="button" className="px-2 text-fg-faint" title="Speak this item next" aria-label="Speak this item next" onClick={() => onJump(i.taskId)}>
											<Icon name="play" size={14} />
										</button>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</div>
	);
}

/** Right-hand side of an ECAM line: the recorded value once there is one, otherwise the action the item asks for. */
function ecamValue(i: RunItem): string {
	if (i.state === "answered") return i.valueText ?? "Done";
	if (i.state === "unsynced") return `${i.valueText ?? "Done"} · sync`;
	if (i.state === "skipped") return "Skipped";
	if (i.state === "needs_screen") return "On screen";
	if (i.state === "current" && i.valueText) return i.valueText;
	if (i.expected?.length) return i.expected[0]!.replace(/\s*\+\s*/g, " "); // a combination ("hivt + körbro") reads as its words
	switch (i.type) {
		case "Checkbox":
			return i.options && i.options.length > 1 ? "Select" : "Check";
		case "DateAndTime":
		case "Time":
			return "Time";
		case "Date":
			return "Date";
		case "Number":
			return "Value";
		case "QuickSelect":
		case "Dropdown":
		case "RadioButtons":
			return "Select";
		default:
			return "Enter";
	}
}

function ManualDialog({ item, onClose, onSubmit }: { item: RunItem; onClose: () => void; onSubmit: (value: string, valueText?: string) => Promise<void> }) {
	const [value, setValue] = useState(item.value ?? "");
	const [busy, setBusy] = useState(false);
	const submit = async (v: string, t?: string) => {
		setBusy(true);
		try {
			await onSubmit(v, t);
		} finally {
			setBusy(false);
		}
	};
	const nowIso = () => new Date().toISOString().slice(0, 16);
	return (
		<div className="fixed inset-0 z-20 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={onClose}>
			<div className="card w-full max-w-md" onClick={(e) => e.stopPropagation()}>
				<div className="card-head">
					<h3 className="card-title">{item.name}</h3>
					<button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
						Close
					</button>
				</div>
				<div className="card-body space-y-3">
					<p className="text-xs text-fg-muted">
						{item.type}
						{item.dataId ? ` · ${item.dataId}` : ""}
					</p>
					{item.type === "Checkbox" ? (
						<div className="flex gap-2">
							<button type="button" className="btn btn-primary flex-1" disabled={busy} onClick={() => void submit("true", "yes")}>
								Yes
							</button>
							<button type="button" className="btn flex-1" disabled={busy} onClick={() => void submit("false", "no")}>
								No
							</button>
						</div>
					) : item.options ? (
						<div className="flex flex-wrap gap-2">
							{item.options.map((o) => (
								<button key={o.value} type="button" className="btn" disabled={busy} onClick={() => void submit(o.value, o.title)}>
									{o.title}
								</button>
							))}
						</div>
					) : item.type === "DateAndTime" ? (
						<form
							className="space-y-2"
							onSubmit={(e) => {
								e.preventDefault();
								const d = new Date(value);
								if (!Number.isNaN(d.getTime())) void submit(d.toISOString().slice(0, 16), `${d.toISOString().slice(11, 16)} UTC`); // Flow stores "yyyy-MM-ddTHH:mm" UTC
							}}
						>
							<input type="datetime-local" className="input" value={value.slice(0, 16)} onChange={(e) => setValue(e.target.value)} />
							<div className="flex gap-2">
								<button type="button" className="btn" onClick={() => setValue(nowIso())}>
									Now
								</button>
								<button type="submit" className="btn btn-primary flex-1" disabled={busy}>
									Save
								</button>
							</div>
						</form>
					) : item.voice || item.type === "Sign" || item.type === "Drawing" ? (
						<form
							className="space-y-2"
							onSubmit={(e) => {
								e.preventDefault();
								if (value.trim()) void submit(value.trim());
							}}
						>
							{(item.type === "Sign" || item.type === "Drawing") && <p className="text-sm text-warn">Signatures and drawings are captured in the Flow app. Enter a note here only if your template accepts text for this item.</p>}
							{item.type === "LongText" ? <textarea className="input" rows={4} value={value} onChange={(e) => setValue(e.target.value)} /> : <input className="input" type={item.type === "Number" ? "number" : item.type === "Date" ? "date" : item.type === "Time" ? "time" : "text"} step="any" value={value} onChange={(e) => setValue(e.target.value)} />}
							<button type="submit" className="btn btn-primary w-full" disabled={busy}>
								Save
							</button>
						</form>
					) : (
						<p className="text-sm text-fg-muted">This item type is handled in the Flow app.</p>
					)}
				</div>
			</div>
		</div>
	);
}

type DiscardOption = { code: string; title: string; requireComment: boolean };

function DiscardDialog({ templateId, onClose, onSubmit }: { templateId?: string; onClose: () => void; onSubmit: (reasonCode: string, comment?: string) => Promise<void> }) {
	const [reasons, setReasons] = useState<DiscardOption[]>([]);
	const [reason, setReason] = useState("");
	const [comment, setComment] = useState("");
	useEffect(() => {
		void api.get<{ reasons: DiscardOption[] }>(`templates/${encodeURIComponent(templateId ?? "any")}/discard-reasons`).then((r) => setReasons(r.reasons));
	}, [templateId]);
	const needComment = reasons.find((r) => r.code === reason)?.requireComment ?? false;
	return (
		<div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
			<div className="card w-full max-w-md" onClick={(e) => e.stopPropagation()}>
				<div className="card-head">
					<h3 className="card-title">Discard this checklist</h3>
				</div>
				<div className="card-body space-y-3">
					<p className="text-sm text-fg-muted">Discard is confirmed on screen only; a misheard word must never discard a checklist.</p>
					<select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
						<option value="">Reason…</option>
						{reasons.map((r) => (
							<option key={r.code} value={r.code}>
								{r.title}
							</option>
						))}
					</select>
					<input className="input" placeholder={needComment ? "Comment (required for this reason)" : "Comment (optional)"} value={comment} onChange={(e) => setComment(e.target.value)} />
					<div className="flex justify-end gap-2">
						<button type="button" className="btn" onClick={onClose}>
							Cancel
						</button>
						<button type="button" className="btn btn-danger" disabled={!reason || (needComment && !comment.trim())} onClick={() => void onSubmit(reason, comment.trim() || undefined)}>
							Discard
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

/** Seconds left until a held item is read. */
function Countdown({ until }: { until?: string }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	if (!until) return null;
	const left = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
	return <>Next item in {left >= 90 ? `${Math.ceil(left / 60)} min` : `${left} s`}. "Next" or the button goes on earlier.</>;
}
