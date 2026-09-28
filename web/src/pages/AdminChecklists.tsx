import { useCallback, useEffect, useState } from "react";
import type { LibraryAvailable, LibraryView } from "../../../server/api.js";
import type { TriggerSpec } from "../../../server/protocol.js";
import { api, toApiError } from "../api.js";
import { Icon } from "../icons.js";
import { Alert, SaveMark, type SaveState } from "../components/ui.js";

type Entry = LibraryView["templates"][number];
const LANGS: [string, string][] = [
	["en", "English"],
	["no", "Norsk"],
	["sv", "Svenska"],
	["de", "Deutsch"],
	["fr", "Français"],
];
/** A word as the hub compares it: lower case, no punctuation. */
const norm = (w: string) =>
	w
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

/**
 * Admin → Checklist setup: the central register. Download checklists from the Templates app, set the language, and tap the
 * words that count as the answer for each item. Stations then pick from this register.
 */
export function ChecklistsTab({ canEdit }: { canEdit: boolean }) {
	const [lib, setLib] = useState<LibraryView | undefined>();
	const [avail, setAvail] = useState<LibraryAvailable["templates"] | undefined>();
	const [err, setErr] = useState<string | undefined>();
	const [busy, setBusy] = useState<string | undefined>();
	const [open, setOpen] = useState<string | undefined>();
	const [saved, setSaved] = useState<SaveState>("idle");

	const loadAvail = useCallback(() => api.get<LibraryAvailable>("library/available").then((a) => setAvail(a.templates), (e) => (setErr(toApiError(e).message), setAvail([]))), []);
	useEffect(() => {
		api.get<LibraryView>("library").then(setLib, (e) => setErr(toApiError(e).message));
		void loadAvail();
	}, [loadAvail]);

	const act = async (key: string, fn: () => Promise<LibraryView>) => {
		setBusy(key);
		setErr(undefined);
		if (key.startsWith("save:")) setSaved("saving");
		try {
			setLib(await fn());
			void loadAvail();
			if (key.startsWith("save:")) setSaved("saved");
		} catch (e) {
			setErr(toApiError(e).message);
			setSaved("idle");
		} finally {
			setBusy(undefined);
		}
	};
	const add = (id: string) => act(id, () => api.post<LibraryView>("library", { templateId: id })).then(() => setOpen(id));
	const remove = (id: string) => act(id, () => api.del<LibraryView>(`library?templateId=${encodeURIComponent(id)}`));
	const saveEntry = (id: string, patch: { language?: string; words?: Record<string, string[]>; triggers?: Record<string, TriggerSpec>; wordsOnly?: boolean; wordMatch?: "exact" | "normal" | "loose"; step?: { mode: "auto" | "ask" | "external" } | { mode: "timer"; delaySec: number } }) => act(`save:${id}`, () => api.put<LibraryView>("library/entry", { templateId: id, ...patch }));

	const notAdded = avail?.filter((a) => !a.registered) ?? [];
	return (
		<div className="space-y-4">
			{err && <Alert>{err}</Alert>}
			<section className="card">
				<div className="card-head">
					<div>
						<h2 className="card-title">1 · Download checklists</h2>
						<p className="text-xs text-fg-muted">From the Maranics Templates app into this hub. Only downloaded checklists can be used on the stations.</p>
					</div>
					<button type="button" className="btn btn-sm" onClick={() => void loadAvail()}>
						Refresh list
					</button>
				</div>
				{!avail ? (
					<p className="card-body text-sm text-fg-muted">Loading from the Templates app…</p>
				) : (
					<ul className="divide-y divide-line">
						{notAdded.map((t) => (
							<li key={t.templateId} className="flex items-center gap-3 px-4 py-2 text-sm">
								<span className="min-w-0 flex-1">
									<span className="block truncate">{t.name}</span>
									<span className="block truncate text-xs text-fg-faint">{[t.refId, t.categoryName].filter(Boolean).join(" · ")}</span>
								</span>
								<button type="button" className="btn btn-sm btn-primary" disabled={!canEdit || !!busy} onClick={() => void add(t.templateId)}>
									{busy === t.templateId ? "Downloading…" : "Download"}
								</button>
							</li>
						))}
						{!notAdded.length && <li className="px-4 py-3 text-sm text-fg-muted">{avail.length ? "Every checklist is downloaded." : "The Templates app returned no checklists for this sign-in."}</li>}
					</ul>
				)}
			</section>

			<div className="flex flex-wrap items-end gap-2 px-1">
				<div className="min-w-0 flex-1 basis-80">
					<h2 className="text-sm font-semibold">2 · Language and answer words</h2>
					<p className="text-xs text-fg-muted">
						Open a checklist and tap the words on each item. <b>Answer</b> = words that count as the answer to the question ("Ramp up" with UP marked: any answer containing "up" checks it). <b>Say to set</b> = words that name the item, so the crew can set it without being asked (stations set to "Crew says the words" or "Both"). Every change is saved at once, for every station.
					</p>
				</div>
				<SaveMark state={saved} />
			</div>
			{!lib ? (
				<p className="text-sm text-fg-muted">Loading…</p>
			) : (
				lib.templates.map((t) => {
					const isOpen = open === t.templateId;
					const marked = Object.keys(t.words).length;
					return (
						<section key={t.templateId} className="card">
							<div className="card-head">
								<button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? undefined : t.templateId)}>
									<Icon name="chevron" size={16} className={`shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
									<span className="min-w-0">
										<span className="card-title block truncate">{t.name}</span>
										<span className="block truncate text-xs text-fg-faint">
											{t.items.length} items · {marked ? `${marked} with answer words` : "no answer words yet"}
										</span>
									</span>
								</button>
								<select className="input w-auto py-1 text-xs" value={t.language ?? ""} disabled={!canEdit || !!busy} onChange={(e) => void saveEntry(t.templateId, { language: e.target.value })} title="Language this checklist is spoken and answered in">
									<option value="">Station language</option>
									{LANGS.map(([v, l]) => (
										<option key={v} value={v}>
											{l}
										</option>
									))}
								</select>
							</div>
							{isOpen && (
								<>
									<label className="flex cursor-pointer items-start gap-2 border-t border-line px-4 py-3 text-sm">
										<input type="checkbox" className="mt-0.5" checked={!t.wordsOnly} disabled={!canEdit || !!busy} onChange={(e) => void saveEntry(t.templateId, { wordsOnly: !e.target.checked })} />
										<span>
											<span className="font-medium">Accept a plain yes, confirm or no</span>
											<span className="block text-xs text-fg-muted">{t.wordsOnly ? "Off: items with marked words only accept an answer that contains one, like \"hivt körbro\". Items without words work as usual." : "On: yes or confirm also answers an item. Turn off to require the marked word."}</span>
										</span>
									</label>
									<label className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 text-sm">
										<span className="min-w-0 flex-1 basis-64">
											<span className="font-medium">How exact must the word be heard</span>
											<span className="block text-xs text-fg-muted">The recogniser often gets a word nearly right, like "kjørbro" for "körbro". Short words (up, on) are always exact.</span>
										</span>
										<select className="input w-auto py-1 text-xs" value={t.wordMatch} disabled={!canEdit || !!busy} onChange={(e) => void saveEntry(t.templateId, { wordMatch: e.target.value as "exact" | "normal" | "loose" })}>
											<option value="exact">Exact: the word itself</option>
											<option value="normal">Normal: a letter or so off</option>
											<option value="loose">Loose: sounds roughly like it</option>
										</select>
									</label>
									<div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 text-sm">
										<span className="min-w-0 flex-1 basis-64">
											<span className="font-medium">When to read the next item</span>
											<span className="block text-xs text-fg-muted">{t.step.mode === "auto" ? "Right after the answer." : t.step.mode === "ask" ? "The hub waits until someone says \"next\" or presses Next item." : t.step.mode === "timer" ? "The hub waits this long after each answer. \"Next\" or the button goes on earlier." : "Another system tells the hub to go on: POST /v1/runs/{id}/proceed or /v1/stations/{station}/proceed. \"Next\" or the button also works."}</span>
										</span>
										<select className="input w-auto py-1 text-xs" value={t.step.mode} disabled={!canEdit || !!busy} onChange={(e) => void saveEntry(t.templateId, { step: e.target.value === "timer" ? { mode: "timer", delaySec: t.step.mode === "timer" ? t.step.delaySec : 60 } : { mode: e.target.value as "auto" | "ask" | "external" } })}>
											<option value="auto">At once</option>
											<option value="ask">When asked (say next)</option>
											<option value="timer">After a time</option>
											<option value="external">When another system says so</option>
										</select>
										{t.step.mode === "timer" && (
											<label className="flex items-center gap-1 text-xs">
												<input className="input w-20 py-1 text-xs" type="number" min={1} max={86400} defaultValue={t.step.delaySec} disabled={!canEdit || !!busy} onBlur={(e) => { const n = Math.max(1, Math.round(Number(e.target.value) || 60)); if (t.step.mode === "timer" && n !== t.step.delaySec) void saveEntry(t.templateId, { step: { mode: "timer", delaySec: n } }); }} />
												seconds
											</label>
										)}
									</div>
									<ItemWords entry={t} canEdit={canEdit} onChange={(words) => void saveEntry(t.templateId, { words })} onTriggers={(triggers) => void saveEntry(t.templateId, { triggers })} />
									<div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-xs text-fg-faint">
										<span className="flex-1">Downloaded {new Date(t.importedAt).toLocaleString()}</span>
										<button type="button" className="btn btn-sm" disabled={!canEdit || !!busy} onClick={() => void add(t.templateId)} title="Fetch the items again after the template changed in Maranics">
											Download again
										</button>
										<button type="button" className="btn btn-sm btn-danger" disabled={!canEdit || !!busy} onClick={() => void remove(t.templateId)}>
											Remove from hub
										</button>
									</div>
								</>
							)}
						</section>
					);
				})
			)}
			{lib && !lib.templates.length && <p className="px-1 text-sm text-fg-muted">Nothing downloaded yet. Until then every checklist of the Templates app is offered on the stations.</p>}
		</div>
	);
}

function ItemWords({ entry, canEdit, onChange, onTriggers }: { entry: Entry; canEdit: boolean; onChange: (w: Record<string, string[]>) => void; onTriggers: (t: Record<string, TriggerSpec>) => void }) {
	const [extra, setExtra] = useState<Record<string, string>>({});
	const set = (key: string, list: string[]) => {
		const next = { ...entry.words };
		if (list.length) next[key] = list;
		else delete next[key];
		onChange(next);
	};
	const setTrigger = (key: string, words: string[], need: number) => {
		const next = { ...entry.triggers };
		if (words.length) next[key] = { words, need: Math.min(Math.max(1, need), words.length) };
		else delete next[key];
		onTriggers(next);
	};
	let section: string | undefined;
	return (
		<ul className="border-t border-line">
			{entry.items.map((it, i) => {
				const list = entry.words[it.key] ?? [];
				/** One entry written "a + b": every word must be heard, in any order. Otherwise any one word answers. */
				const together = list.length === 1 && list[0].includes("+");
				const words = together ? list[0].split("+").map(norm).filter(Boolean) : list;
				const tokens = it.name.split(/\s+/).filter(Boolean);
				const setWords = (next: string[]) => set(it.key, together && next.length > 1 ? [next.join(" + ")] : next);
				const trigger = entry.triggers[it.key];
				const triggerWords = trigger?.words ?? [];
				const need = Math.min(Math.max(1, trigger?.need ?? 1), Math.max(1, triggerWords.length));
				const head = it.section !== section ? (section = it.section) : undefined;
				return (
					<li key={`${it.key}-${i}`}>
						{head && <p className="bg-panel-2 px-4 py-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">{head}</p>}
						<div className="space-y-1.5 border-b border-line px-4 py-2.5">
							<WordRow
								label="Answer"
								tone="info"
								tokens={tokens}
								words={words}
								canEdit={canEdit}
								draft={extra[it.key] ?? ""}
								onDraft={(v) => setExtra((x) => ({ ...x, [it.key]: v }))}
								onWords={setWords}
							>
								{words.length > 1 && (
									<button
										type="button"
										disabled={!canEdit}
										aria-pressed={together}
										title={together ? "The crew must say every marked word, in any order." : "Any one of the marked words answers the item."}
										onClick={() => set(it.key, together ? words : [words.join(" + ")])}
										className={`rounded-md border px-1.5 py-0.5 text-xs ${together ? "border-info bg-info/15 font-semibold text-info" : "border-line-strong text-fg-muted hover:border-info"}`}
									>
										{together ? "all words together" : "any one word"}
									</button>
								)}
							</WordRow>
							<WordRow
								label="Say to set"
								tone="ok"
								tokens={tokens}
								words={triggerWords}
								canEdit={canEdit}
								draft={extra[`t:${it.key}`] ?? ""}
								onDraft={(v) => setExtra((x) => ({ ...x, [`t:${it.key}`]: v }))}
								onWords={(next) => setTrigger(it.key, next, need)}
							>
								{triggerWords.length > 1 && (
									<select
										className="input w-auto py-0.5 text-xs"
										value={need}
										disabled={!canEdit}
										title="How many of these words the crew must say. Order never matters."
										onChange={(e) => setTrigger(it.key, triggerWords, Number(e.target.value))}
									>
										<option value={1}>any one word</option>
										{triggerWords.slice(2).map((_, k) => (
											<option key={k} value={k + 2}>
												at least {k + 2} words
											</option>
										))}
										<option value={triggerWords.length}>all {triggerWords.length} words</option>
									</select>
								)}
							</WordRow>
						</div>
					</li>
				);
			})}
			{!entry.items.length && <li className="px-4 py-3 text-sm text-fg-muted">No items in this checklist.</li>}
		</ul>
	);
}

/**
 * One row of tappable words for an item: the words of its own name plus anything the admin typed. Used twice — for
 * the answer words and for the "say to set" trigger words — so both look and behave the same.
 */
function WordRow({ label, tone, tokens, words, canEdit, draft, onDraft, onWords, children }: { label: string; tone: "info" | "ok"; tokens: string[]; words: string[]; canEdit: boolean; draft: string; onDraft: (v: string) => void; onWords: (next: string[]) => void; children?: React.ReactNode }) {
	const inName = new Set(tokens.map(norm));
	const custom = words.filter((w) => !inName.has(w));
	const toggle = (w: string) => onWords(words.includes(w) ? words.filter((x) => x !== w) : [...words, w]);
	const on = tone === "info" ? "border-info bg-info/15 font-bold text-info" : "border-ok bg-ok/15 font-bold text-ok";
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
			<span className="w-20 shrink-0 text-xs text-fg-faint">{label}</span>
			<div className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-1">
				{tokens.map((tok, k) => {
					const w = norm(tok);
					const marked = !!w && words.includes(w);
					return (
						<button key={k} type="button" disabled={!canEdit || !w} aria-pressed={marked} onClick={() => toggle(w)} className={`rounded-md border px-1.5 py-0.5 font-mono text-sm uppercase ${marked ? on : "border-transparent hover:border-line-strong"}`}>
							{tok}
						</button>
					);
				})}
			</div>
			<div className="flex flex-wrap items-center gap-1">
				{custom.map((w) => (
					<button key={w} type="button" disabled={!canEdit} onClick={() => toggle(w)} className={`rounded-md border px-1.5 py-0.5 font-mono text-sm uppercase ${on}`} title="Remove">
						{w} ×
					</button>
				))}
				<input
					className="input mono w-32 py-1 text-xs uppercase"
					placeholder="+ other word"
					value={draft}
					disabled={!canEdit}
					onChange={(e) => onDraft(e.target.value)}
					onKeyDown={(e) => {
						const w = norm(draft);
						if (e.key !== "Enter" || !w) return;
						if (!words.includes(w)) onWords([...words, w]);
						onDraft("");
					}}
				/>
				{children}
			</div>
		</div>
	);
}
