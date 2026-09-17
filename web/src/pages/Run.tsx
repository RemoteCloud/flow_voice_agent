import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunView } from "../../../server/api.js";
import type { HubEvent, RunItem } from "../../../server/protocol.js";
import { api, toApiError } from "../api.js";
import { useApp } from "../context.js";
import { Icon } from "../icons.js";
import { navigate } from "../router.js";
import { LanguageSelect, STATE_TEXT, useVoice } from "../voice.js";

/** `mobile` (the Android agent): current item, mic, the few run buttons, items behind a toggle. No typed input, no hands-free switch, no event log. */
export function RunPage({ runId, mobile = false }: { runId: string; mobile?: boolean }) {
	const { me, boot, stations } = useApp();
	const v = useVoice();
	const [run, setRun] = useState<RunView | undefined>();
	const [err, setErr] = useState<string | undefined>();
	const [typed, setTyped] = useState("");
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
	const role = v.role;
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
	const upNext = useMemo(() => (current && run ? run.items.filter((i) => i.index > current.index && i.voice && i.state === "unanswered").slice(0, 2) : []), [run, current]);
	const sections = useMemo(() => {
		const out: { name: string | undefined; items: RunItem[] }[] = [];
		for (const i of run?.items ?? []) {
			const last = out[out.length - 1];
			if (last && last.name === i.sectionName) last.items.push(i);
			else out.push({ name: i.sectionName, items: [i] });
		}
		return out;
	}, [run]);

	if (!run) return <p className="text-sm text-fg-muted">{err ?? "Loading run…"}</p>;
	const done = run.state === "completed" || run.state === "abandoned";
	const listening = voice === "listening";

	return (
		<div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
			<div className="space-y-4">
				{/* current item */}
				<section className="card">
					<div className="card-head">
						<div>
							<h1 className="card-title">{run.templateName}</h1>
							<p className="text-xs text-fg-muted">
								{station?.name ?? run.stationId} · {run.state}
								{run.pendingReason ? ` · ${run.pendingReason}` : ""} · {run.users.map((u) => u.name ?? u.sub).join(", ")}
							</p>
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
						<p className="text-xs text-fg-muted">
							{run.answered} of {run.total} answered · {run.needsScreen} need the screen · {run.skipped} skipped
							{run.unsynced ? ` · ${run.unsynced} waiting to sync` : ""}
						</p>
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
								{mobile && upNext.length > 0 && (
									<div className="mt-4 border-t border-line pt-3">
										<p className="text-xs tracking-wide text-fg-faint uppercase">Up next</p>
										<ul className="mt-1 space-y-0.5 text-sm text-fg-muted">
											{upNext.map((i) => (
												<li key={i.taskId} className="truncate">
													<span className="text-fg-faint">{i.index}. </span>
													{i.name}
												</li>
											))}
										</ul>
									</div>
								)}
							</div>
						) : (
							<p className="mt-4 text-lg text-fg-muted">{done ? `Run ${run.state}.` : run.state === "paused" ? "Paused." : run.answered >= run.total ? "All items answered — complete the checklist below." : "Waiting for the next item…"}</p>
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
								<div className="mt-2 flex gap-2">
									<button type="button" className="btn btn-primary" onClick={() => void act("answer", { transcript: "confirm" })}>
										Confirm
									</button>
									<button type="button" className="btn" onClick={() => void act("answer", { transcript: "no" })}>
										No
									</button>
								</div>
							</div>
						)}
						{(transcript || run.transcript) && <p className="mt-3 text-sm text-fg-muted italic">“{transcript || run.transcript}”</p>}
						{run.lastSpoken && <p className="mt-2 text-xs text-fg-faint">Hub: {run.lastSpoken}</p>}
					</div>
				</section>

				{/* voice controls */}
				<section className="card">
					<div className="card-body">
						{voice === "disconnected" ? (
							<button type="button" className="btn btn-primary btn-lg w-full" onClick={() => void startVoice()} disabled={done}>
								Start voice on {station?.name ?? run.stationId}
							</button>
						) : (
							<div className="flex flex-col items-center gap-3">
								{role === "observer" ? (
									<div className="text-center">
										<p className="text-sm text-fg-muted">Another device holds the microphone on this station.</p>
										<button type="button" className="btn mt-2" onClick={() => v.takeover()}>
											Take over
										</button>
									</div>
								) : (
									<button
										type="button"
										className={`flex h-32 w-32 items-center justify-center rounded-full border-4 text-lg font-semibold select-none ${listening ? "mic-ring border-danger bg-danger/20 text-danger" : "border-accent bg-accent/10 text-accent active:bg-accent/30"}`}
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
										{listening ? "Listening" : "Hold to talk"}
									</button>
								)}
								<div className="flex flex-wrap justify-center gap-2">
									<button type="button" className="btn" onClick={() => void act("repeat")} disabled={done || !current}>
										Repeat
									</button>
									<button type="button" className="btn" onClick={() => void act("skip", { reason: "skipped on screen" })} disabled={done || !current}>
										Skip
									</button>
									<button type="button" className="btn" onClick={() => current && setManual(current)} disabled={done || !current}>
										Manual entry
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
									<LanguageSelect />
								</div>
								{!mobile && (
									<label className="flex items-center gap-2 text-sm">
										<input type="checkbox" checked={handsFree} onChange={(e) => v.setHandsFree(e.target.checked)} disabled={!v.handsFreeSupported} />
										Hands-free (open mic between items: say “next”, “repeat”, “pause”, “complete”, “discard”, or answer unprompted)
									</label>
								)}
								{!mobile && (
									<form
										className="flex w-full gap-2"
										onSubmit={(e) => {
											e.preventDefault();
											if (!typed.trim()) return;
											if (role === "endpoint" && v.active) v.sayText(typed);
											else void act("answer", { transcript: typed });
											setTyped("");
										}}
									>
										<input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type what you would say (e.g. “five minutes ago”, “confirm”, “skip”)" />
										<button type="submit" className="btn">
											Send
										</button>
									</form>
								)}
							</div>
						)}
						{(err || v.error) && <p className="mt-3 text-sm text-danger">{err ?? v.error}</p>}
						{!mobile && (
							<p className="help mt-3">
								{handsFree ? "Hands-free: the mic opens after every question and stays open between items. " : "Push-to-talk: hold the button, or hold Space. "}
								STT runs {boot.speech.stt === "endpoint" ? "on this device" : "on the hub"}; TTS on this device.
								{boot.speech.stt !== "endpoint" ? " Hands-free needs on-device recognition." : ""}
							</p>
						)}
					</div>
				</section>

				{/* checklist actions */}
				<section className="card">
					<div className="card-body flex flex-wrap gap-2">
						<button type="button" className="btn btn-primary" disabled={done || run.answered < run.total || run.unsynced > 0} onClick={() => void act("complete")} title={run.unsynced ? "Blocked: values are still syncing to Flow" : run.answered < run.total ? "Blocked: items still open" : "Complete the checklist in Flow"}>
							Complete checklist
						</button>
						<button type="button" className="btn btn-danger" disabled={done} onClick={() => setDiscardOpen(true)}>
							Discard…
						</button>
						<button type="button" className="btn btn-ghost" disabled={done} onClick={() => void act("abandon")}>
							Stop run
						</button>
						<button type="button" className="btn btn-ghost ml-auto" onClick={() => navigate({ page: "picker" })}>
							Back to checklists
						</button>
					</div>
					{run.unsynced > 0 && <p className="px-4 pb-3 text-xs text-warn">Complete is blocked while {run.unsynced} value(s) wait in the outbox.</p>}
				</section>
			</div>

			{/* item list: done / now / next */}
			<section className="card">
				<div className="card-head">
					<h2 className="card-title">
						Items <span className="ml-1 font-normal text-fg-muted">{run.answered}/{run.total}</span>
					</h2>
					{!mobile && <span className="text-xs text-fg-faint">Tap an item to answer it by hand or jump to it.</span>}
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
			{discardOpen && <DiscardDialog templateId={run.templateId} onClose={() => setDiscardOpen(false)} onSubmit={(reasonCode, comment) => act("discard", { reasonCode, comment }).then(() => setDiscardOpen(false))} />}
		</div>
	);
}

/** Sectioned list: answered rows carry a check, the current row is highlighted, upcoming rows stay muted. On phones it scrolls with the page and follows the current item. */
function ItemList({ run, sections, mobile, done, onManual, onJump }: { run: RunView; sections: { name: string | undefined; items: RunItem[] }[]; mobile: boolean; done: boolean; onManual: (item: RunItem) => void; onJump: (taskId: string) => void }) {
	useEffect(() => {
		if (!mobile || !run.currentTaskId) return;
		document.getElementById(`item-${run.currentTaskId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [mobile, run.currentTaskId]);
	const counts = (items: RunItem[]) => {
		const total = items.filter((i) => i.state !== "info").length;
		const answered = items.filter((i) => i.state === "answered" || i.state === "unsynced").length;
		return total ? `${answered}/${total}` : "";
	};
	return (
		<div className={mobile ? "" : "max-h-[70vh] overflow-y-auto"}>
			{sections.map((s, si) => (
				<div key={si}>
					{s.name && (
						<p className="section-sticky flex items-center justify-between px-4 py-1.5 text-xs font-medium tracking-wide text-fg-muted uppercase">
							<span className="truncate">{s.name}</span>
							<span className="ml-2 shrink-0 font-normal normal-case">{counts(s.items)}</span>
						</p>
					)}
					<ul className="divide-y divide-line">
						{s.items.map((i) => {
							const isDone = i.state === "answered" || i.state === "unsynced" || i.state === "skipped";
							const isNow = i.state === "current";
							return (
								<li key={i.taskId} id={`item-${i.taskId}`} className={`flex items-center gap-3 px-4 py-2.5 ${isNow ? "row-current" : ""} ${isDone ? "text-fg-muted" : ""}`}>
									<StateMark item={i} />
									<button type="button" className="min-w-0 flex-1 text-left" onClick={() => onManual(i)} disabled={done || i.state === "info"}>
										<p className={`truncate text-sm ${isNow ? "font-semibold text-fg" : ""}`}>
											<span className="text-fg-faint">{i.index}. </span>
											{i.name}
										</p>
										<p className="truncate text-xs text-fg-muted">
											{isNow ? "Now" : i.state === "answered" || i.state === "unsynced" ? (i.valueText ?? "Answered") : i.state === "skipped" ? `Skipped${i.skipReason ? ` · ${i.skipReason}` : ""}` : i.state === "needs_screen" ? "Needs the screen" : i.state === "info" ? "Information" : mobile ? "Next" : i.type}
											{isNow && i.valueText ? ` · ${i.valueText}` : ""}
											{i.state === "unsynced" ? " · waiting to sync" : ""}
											{!mobile && !isNow && i.state !== "info" ? ` · ${i.type}` : ""}
										</p>
									</button>
									{i.voice && !done && !isNow && run.state === "active" && (
										<button type="button" className="btn btn-sm btn-ghost" title="Speak this item next" aria-label="Speak this item next" onClick={() => onJump(i.taskId)}>
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

function StateMark({ item }: { item: RunItem }) {
	if (item.state === "answered" || item.state === "unsynced") {
		return (
			<span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${item.state === "unsynced" ? "bg-warn/15 text-warn" : "bg-ok/15 text-ok"}`} title={item.state}>
				<Icon name="check" size={14} strokeWidth={2.5} />
			</span>
		);
	}
	const cls = {
		current: "bg-accent",
		skipped: "bg-danger/70",
		needs_screen: "border-2 border-warn",
		unanswered: "border-2 border-line-strong",
		info: "border border-line",
	}[item.state];
	return (
		<span className="flex h-6 w-6 shrink-0 items-center justify-center" title={item.state}>
			<span className={`h-3 w-3 rounded-full ${cls}`} />
		</span>
	);
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
