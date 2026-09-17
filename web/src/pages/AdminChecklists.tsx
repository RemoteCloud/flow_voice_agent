import { useCallback, useEffect, useState } from "react";
import type { LibraryAvailable, LibraryView } from "../../../server/api.js";
import { api, toApiError } from "../api.js";
import { Icon } from "../icons.js";

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

	const loadAvail = useCallback(() => api.get<LibraryAvailable>("library/available").then((a) => setAvail(a.templates), (e) => (setErr(toApiError(e).message), setAvail([]))), []);
	useEffect(() => {
		api.get<LibraryView>("library").then(setLib, (e) => setErr(toApiError(e).message));
		void loadAvail();
	}, [loadAvail]);

	const act = async (key: string, fn: () => Promise<LibraryView>) => {
		setBusy(key);
		setErr(undefined);
		try {
			setLib(await fn());
			void loadAvail();
		} catch (e) {
			setErr(toApiError(e).message);
		} finally {
			setBusy(undefined);
		}
	};
	const add = (id: string) => act(id, () => api.post<LibraryView>("library", { templateId: id })).then(() => setOpen(id));
	const remove = (id: string) => act(id, () => api.del<LibraryView>(`library?templateId=${encodeURIComponent(id)}`));
	const saveEntry = (id: string, patch: { language?: string; words?: Record<string, string[]>; wordsOnly?: boolean }) => act(`save:${id}`, () => api.put<LibraryView>("library/entry", { templateId: id, ...patch }));

	const notAdded = avail?.filter((a) => !a.registered) ?? [];
	return (
		<div className="space-y-4">
			{err && <p className="text-sm text-danger">{err}</p>}
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

			<div>
				<h2 className="px-1 text-sm font-semibold">2 · Language and answer words</h2>
				<p className="px-1 text-xs text-fg-muted">Open a checklist and tap the words that count as the answer. "Ramp up" with UP marked: any answer that contains "up" checks the item. Saved at once, for every station.</p>
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
									<ItemWords entry={t} canEdit={canEdit} onChange={(words) => void saveEntry(t.templateId, { words })} />
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

function ItemWords({ entry, canEdit, onChange }: { entry: Entry; canEdit: boolean; onChange: (w: Record<string, string[]>) => void }) {
	const [extra, setExtra] = useState<Record<string, string>>({});
	const set = (key: string, list: string[]) => {
		const next = { ...entry.words };
		if (list.length) next[key] = list;
		else delete next[key];
		onChange(next);
	};
	let section: string | undefined;
	return (
		<ul className="border-t border-line">
			{entry.items.map((it, i) => {
				const words = entry.words[it.key] ?? [];
				const tokens = it.name.split(/\s+/).filter(Boolean);
				const inName = new Set(tokens.map(norm));
				const custom = words.filter((w) => !inName.has(w));
				const toggle = (w: string) => set(it.key, words.includes(w) ? words.filter((x) => x !== w) : [...words, w]);
				const head = it.section !== section ? (section = it.section) : undefined;
				return (
					<li key={`${it.key}-${i}`}>
						{head && <p className="bg-panel-2 px-4 py-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">{head}</p>}
						<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
							<div className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-1">
								{tokens.map((tok, k) => {
									const w = norm(tok);
									const on = !!w && words.includes(w);
									return (
										<button key={k} type="button" disabled={!canEdit || !w} aria-pressed={on} onClick={() => toggle(w)} className={`rounded-md border px-1.5 py-0.5 font-mono text-sm uppercase ${on ? "border-info bg-info/15 font-bold text-info" : "border-transparent hover:border-line-strong"}`}>
											{tok}
										</button>
									);
								})}
							</div>
							<div className="flex flex-wrap items-center gap-1">
								{custom.map((w) => (
									<button key={w} type="button" disabled={!canEdit} onClick={() => toggle(w)} className="rounded-md border border-info bg-info/15 px-1.5 py-0.5 font-mono text-sm font-bold text-info uppercase" title="Remove">
										{w} ×
									</button>
								))}
								<input
									className="input mono w-32 py-1 text-xs uppercase"
									placeholder="+ other word"
									value={extra[it.key] ?? ""}
									disabled={!canEdit}
									onChange={(e) => setExtra((x) => ({ ...x, [it.key]: e.target.value }))}
									onKeyDown={(e) => {
										const w = norm(extra[it.key] ?? "");
										if (e.key !== "Enter" || !w) return;
										if (!words.includes(w)) set(it.key, [...words, w]);
										setExtra((x) => ({ ...x, [it.key]: "" }));
									}}
								/>
							</div>
						</div>
					</li>
				);
			})}
			{!entry.items.length && <li className="px-4 py-3 text-sm text-fg-muted">No items in this checklist.</li>}
		</ul>
	);
}
