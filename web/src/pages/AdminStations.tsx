import { useEffect, useState } from "react";
import type { ChecklistPick, JoinTokenResponse, LibraryView, Station, StationView, StatusResponse, VoiceProfile } from "../../../server/api.js";
import { encodeQr, qrToSvg } from "../../../server/core/qr.js";
import { api, toApiError } from "../api.js";
import { QrCode } from "../components/QrCode.js";
import { Icon } from "../icons.js";

const LANGS = ["en", "sv", "no", "fr", "de"];
const LANG_NAMES: Record<string, string> = { en: "English", no: "Norsk", sv: "Svenska", de: "Deutsch", fr: "Français" };
type Minted = { token: string; path: string; tokenHint: string };

const strip = (s: StationView): Station => {
	const { endpoint: _e, activeRun: _r, join: _j, ...st } = s;
	return st;
};

/** Admin → Stations: one card per station (form fields + QR join poster), plus an advanced JSON view. */
export function StationsTab({ s, reload, canEdit }: { s: StatusResponse; reload: () => Promise<void>; canEdit: boolean }) {
	const [rows, setRows] = useState<Station[]>(() => s.stations.map(strip));
	const [dirty, setDirty] = useState(false);
	const [json, setJson] = useState(false);
	const [text, setText] = useState("");
	const [err, setErr] = useState<string | undefined>();
	const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
	const [minted, setMinted] = useState<Record<string, Minted>>({});
	const [base, setBase] = useState(() => location.origin);

	const [templates, setTemplates] = useState<ChecklistPick[] | undefined>();
	const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
	const toggleOpen = (id: string) => setOpenIds((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
	useEffect(() => {
		api.get<VoiceProfile[]>("profiles").then(setProfiles, () => setProfiles([]));
		// stations pick from the central register; an empty register falls back to everything the Templates app offers
		api.get<LibraryView>("library").then(
			(l) => {
				if (l.templates.length) setTemplates(l.templates.map((t) => ({ templateId: t.templateId, templateName: t.name, language: t.language }) as ChecklistPick));
				else
					api.get<ChecklistPick[]>("checklists").then(
						(p) => setTemplates(p.filter((x) => x.source === "template")),
						() => setTemplates([]),
					);
			},
			() => setTemplates([]),
		);
	}, []);
	// pick up server-side changes (another admin, portable files) while nothing is being edited here
	useEffect(() => {
		if (!dirty) setRows(s.stations.map(strip));
	}, [s.stations, dirty]);

	const edit = (i: number, patch: Partial<Station>) => {
		setRows((r) => r.map((st, k) => (k === i ? { ...st, ...patch } : st)));
		setDirty(true);
	};
	/** Selects and tick boxes save at once (together with anything typed before). */
	const pick = (i: number, patch: Partial<Station>) => {
		const next = rows.map((st, k) => (k === i ? { ...st, ...patch } : st));
		setRows(next);
		void save(next);
	};
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
	const save = async (list: Station[] = rows) => {
		setSaveState("saving");
		try {
			await api.put("stations", list);
			setErr(undefined);
			setDirty(false);
			await reload();
			setSaveState("saved");
		} catch (e) {
			setSaveState("idle");
			setErr(toApiError(e).message);
		}
	};
	/** Text fields save when the cursor leaves them: there is no Save button. */
	const commit = () => {
		if (dirty) void save();
	};
	const applyJson = () => {
		try {
			const list = JSON.parse(text) as Station[];
			if (!Array.isArray(list)) throw new SyntaxError("expected an array");
			setRows(list);
			setJson(false);
			setErr(undefined);
			void save(list);
		} catch (e) {
			setErr(e instanceof SyntaxError ? `JSON: ${e.message}` : String(e));
		}
	};
	const mint = async (stationId: string) => {
		try {
			const res = await api.post<JoinTokenResponse>(`stations/${encodeURIComponent(stationId)}/join-token`);
			setMinted((m) => ({ ...m, [stationId]: { token: res.token, path: res.path, tokenHint: res.tokenHint } }));
			setBase(new URL(res.url).origin);
			setErr(undefined);
			await reload();
		} catch (e) {
			setErr(toApiError(e).message);
		}
	};
	const [newName, setNewName] = useState("");
	const [newLocation, setNewLocation] = useState("");
	const [newLang, setNewLang] = useState("en");
	/** One step for the common case: create the station, save it, and show its QR poster. */
	const createWithQr = async () => {
		const name = newName.trim();
		if (!name) return;
		const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "station";
		let stationId = slug;
		for (let n = 2; rows.some((r) => r.stationId === stationId); n++) stationId = `${slug}-${n}`;
		const list = [...rows, { stationId, name, location: newLocation.trim() || undefined, language: newLang, audioPolicy: "ptt", autoStartAllowed: false, verbosity: "full", voiceActions: true, defaultProfile: null } as Station];
		try {
			await api.put("stations", list);
			setRows(list);
			setDirty(false);
			setNewName("");
			setNewLocation("");
			await mint(stationId);
		} catch (e) {
			setErr(toApiError(e).message);
		}
	};
	const revoke = async (stationId: string) => {
		if (!confirm("Revoke this QR code? Posters carrying it stop working; phones already joined stay signed in.")) return;
		try {
			await api.del(`stations/${encodeURIComponent(stationId)}/join-token`);
			setMinted((m) => {
				const { [stationId]: _gone, ...rest } = m;
				return rest;
			});
			await reload();
		} catch (e) {
			setErr(toApiError(e).message);
		}
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2 px-1">
				<p className="text-xs text-fg-muted">One station = one place with its own link and QR code. Everything you change here is saved at once.</p>
				<span className={`ml-auto text-xs ${saveState === "saved" ? "text-ok" : "text-fg-faint"}`} aria-live="polite">
					{saveState === "saving" ? "Saving…" : dirty ? "Not saved yet" : saveState === "saved" ? "Saved ✓" : ""}
				</span>
			</div>
			<section className="card">
				<div className="card-head">
					<h2 className="card-title">Add a station</h2>
				</div>
				<form
					className="card-body grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
					onSubmit={(e) => {
						e.preventDefault();
						void createWithQr();
					}}
				>
					<div>
						<label className="label">Name</label>
						<input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Bridge" disabled={!canEdit} />
					</div>
					<div>
						<label className="label">Vessel / location</label>
						<input className="input" value={newLocation} onChange={(e) => setNewLocation(e.target.value)} placeholder="MF Example" disabled={!canEdit} />
					</div>
					<div>
						<label className="label">Language</label>
						<select className="input" value={newLang} onChange={(e) => setNewLang(e.target.value)} disabled={!canEdit}>
							{LANGS.map((l) => (
								<option key={l} value={l}>
									{LANG_NAMES[l] ?? l}
								</option>
							))}
						</select>
					</div>
					<button type="submit" className="btn btn-primary" disabled={!canEdit || !newName.trim() || dirty} >
						Add station
					</button>
				</form>
				<p className="help px-4 pb-3">The new station opens below with its own link and QR code. Open the link on a PC, or scan the code with the phone or tablet.</p>
			</section>
			{err && <p className="text-sm text-danger">{err}</p>}
			{rows.map((st, i) => {
				const live = s.stations.find((x) => x.stationId === st.stationId);
				const isNew = !live;
				const isOpen = isNew || openIds.has(st.stationId);
				const nTpl = Object.keys(st.templates ?? {}).length;
				return (
					<section key={`${st.stationId}-${i}`} className="card">
						<div className="card-head">
							<button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={isOpen} onClick={() => toggleOpen(st.stationId)}>
								<Icon name="chevron" size={16} className={`shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
								<h2 className="card-title truncate">
									{st.location ? `${st.location} · ` : ""}
									{st.name || st.stationId}
								</h2>
								<span className="truncate text-xs text-fg-faint">{LANG_NAMES[st.language] ?? st.language} · {nTpl ? `${nTpl} checklist${nTpl > 1 ? "s" : ""}` : "all checklists"}</span>
							</button>
							<div className="flex items-center gap-3 text-xs text-fg-faint">
								{live?.endpoint ? <span className="text-ok">● in use now</span> : <span>not connected</span>}
							</div>
						</div>
						<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]" hidden={!isOpen}>
							<div className="card-body grid gap-3 sm:grid-cols-2">
								<div>
									<label className="label">Name</label>
									<input className="input" value={st.name} disabled={!canEdit} onChange={(e) => edit(i, { name: e.target.value })} onBlur={commit} />
								</div>
								<div>
									<label className="label">Vessel / location</label>
									<input className="input" value={st.location ?? ""} placeholder="e.g. MF Example" disabled={!canEdit} onChange={(e) => edit(i, { location: e.target.value || undefined })} onBlur={commit} />
								</div>
								<div>
									<label className="label">Language of the voice menu</label>
									<select className="input" value={st.language} disabled={!canEdit} onChange={(e) => pick(i, { language: e.target.value })}>
										{LANGS.map((l) => (
											<option key={l} value={l}>
												{LANG_NAMES[l] ?? l}
											</option>
										))}
									</select>
									<p className="help">Each checklist speaks its own language (Checklist setup).</p>
								</div>
								<div className="flex flex-col justify-end gap-2 pb-1 text-sm">
									<label className="flex items-center gap-2">
										<input type="checkbox" className="h-5 w-5" checked={!!st.holdToAnswer} disabled={!canEdit} onChange={(e) => pick(i, { holdToAnswer: e.target.checked })} />
										Noisy place: hold the button while answering
									</label>
								</div>
								<div className="sm:col-span-2">
									<label className="label">How much the voice says</label>
									<select className="input" value={st.verbosity ?? "full"} disabled={!canEdit} onChange={(e) => pick(i, { verbosity: e.target.value as Station["verbosity"] })}>
										<option value="full">Everything: item number, question, item and answer repeated</option>
										<option value="short">Short: question, then only the answer</option>
										<option value="silent">Least: only the question</option>
									</select>
									<p className="help">Applies at once, also to a checklist that is open.</p>
								</div>
								<div className="sm:col-span-2">
									<TemplateRules rules={st.templates} templates={templates} canEdit={canEdit} onChange={(t) => pick(i, { templates: t })} />
								</div>
								<details className="rounded-lg border border-line sm:col-span-2">
									<summary className="cursor-pointer px-3 py-2 text-sm text-fg-muted">Advanced settings</summary>
									<div className="grid gap-3 border-t border-line p-3 sm:grid-cols-2">
										<div>
											<label className="label">Microphone</label>
											<select className="input" value={st.audioPolicy} disabled={!canEdit} onChange={(e) => pick(i, { audioPolicy: e.target.value === "open" ? "open" : "ptt" })}>
												<option value="ptt">Push to talk</option>
												<option value="open">Always listening (hands-free)</option>
											</select>
										</div>
										<label className="flex items-center gap-2 text-sm">
											<input type="checkbox" className="h-5 w-5" checked={st.voiceActions !== false} disabled={!canEdit} onChange={(e) => pick(i, { voiceActions: e.target.checked })} />
											Complete / discard by voice (asks twice)
										</label>
										<label className="flex items-center gap-2 text-sm">
											<input type="checkbox" className="h-5 w-5" checked={!!st.autoStartAllowed} disabled={!canEdit} onChange={(e) => pick(i, { autoStartAllowed: e.target.checked })} />
											Checklists started by other systems may begin on their own
										</label>
										<div>
											<label className="label">Voice profile</label>
											<select className="input" value={st.defaultProfile ?? ""} disabled={!canEdit} onChange={(e) => pick(i, { defaultProfile: e.target.value || null })}>
												<option value="">None</option>
												{profiles.map((p) => (
													<option key={p.profileId} value={p.profileId}>
														{p.profileId}
													</option>
												))}
											</select>
										</div>
										<div>
											<label className="label">Station id</label>
											<input className="input mono" value={st.stationId} readOnly={!isNew} disabled={!canEdit} onChange={(e) => edit(i, { stationId: e.target.value.trim() })} onBlur={commit} />
										</div>
										<div className="sm:col-span-2">
											<button
												type="button"
												className="btn btn-sm btn-danger"
												disabled={!canEdit}
												onClick={() => {
													if (!confirm(`Remove the station "${st.name}"? Its link and QR code stop working.`)) return;
													const next = rows.filter((_, k) => k !== i);
													setRows(next);
													void save(next);
												}}
											>
												Remove this station
											</button>
										</div>
									</div>
								</details>
							</div>
							{!isNew && <JoinPanel station={live} minted={minted[st.stationId]} base={base} setBase={setBase} canEdit={canEdit} onMint={() => void mint(st.stationId)} onRevoke={() => void revoke(st.stationId)} />}
						</div>
					</section>
				);
			})}
			{!rows.length && <p className="text-sm text-fg-muted">No stations yet. Add one above.</p>}
			<div className="flex justify-end">
				<button
					type="button"
					className="btn btn-sm btn-ghost text-fg-faint"
					onClick={() => {
						setText(JSON.stringify(rows, null, 2));
						setJson((j) => !j);
					}}
				>
					{json ? "Hide JSON" : "Advanced: edit as JSON"}
				</button>
			</div>
			{json && (
				<section className="card">
					<div className="card-body space-y-2">
						<textarea className="input mono" rows={14} value={text} onChange={(e) => setText(e.target.value)} disabled={!canEdit} />
						<button type="button" className="btn btn-sm" disabled={!canEdit} onClick={applyJson}>
							Apply and save
						</button>
					</div>
				</section>
			)}
		</div>
	);
}

type Rules = NonNullable<Station["templates"]>;

/** Per station: tick the checklists used here. Nothing ticked = all of them. A ticked one can be "use only". */
function TemplateRules({ rules, templates, canEdit, onChange }: { rules: Station["templates"]; templates: ChecklistPick[] | undefined; canEdit: boolean; onChange: (r: Station["templates"]) => void }) {
	const r: Rules = rules ?? {};
	const limited = Object.keys(r).length > 0;
	const put = (next: Rules) => onChange(Object.keys(next).length ? next : undefined);
	const toggle = (id: string) => {
		const next = { ...r };
		if (next[id]) delete next[id];
		else next[id] = { access: "start" };
		put(next);
	};
	// rules for checklists that are no longer in the hub still show, so they can be unticked
	const gone = Object.keys(r).filter((id) => templates && !templates.some((t) => t.templateId === id));
	return (
		<div className="rounded-lg border border-line">
			<div className="flex flex-wrap items-center gap-2 px-3 py-2">
				<div className="min-w-0 flex-1 basis-60">
					<h3 className="text-sm font-medium">Checklists on this station</h3>
					<p className="text-xs text-fg-muted">{limited ? "Only the ticked checklists show on this station." : "Nothing ticked: all checklists show here. Tick some to show only those."}</p>
				</div>
				{limited && (
					<button type="button" className="btn btn-sm" disabled={!canEdit} onClick={() => put({})}>
						Show all
					</button>
				)}
			</div>
			{!templates ? (
				<p className="border-t border-line px-3 py-2 text-sm text-fg-muted">Loading checklists…</p>
			) : (
				<ul className="divide-y divide-line border-t border-line">
					{templates.map((t) => {
						const on = !!r[t.templateId];
						return (
							<li key={t.templateId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
								<label className="flex min-w-0 flex-1 basis-48 cursor-pointer items-center gap-3">
									<input type="checkbox" className="h-5 w-5 shrink-0" checked={on} disabled={!canEdit} onChange={() => toggle(t.templateId)} />
									<span className="min-w-0 truncate">{t.templateName}</span>
									{t.language && <span className="shrink-0 text-xs text-fg-faint">{LANG_NAMES[t.language] ?? t.language}</span>}
								</label>
								{on && (
									<select className="input w-auto py-1 text-xs" value={r[t.templateId]?.access === "use" ? "use" : "start"} disabled={!canEdit} onChange={(e) => put({ ...r, [t.templateId]: { ...r[t.templateId], access: e.target.value as "start" | "use" } })}>
										<option value="start">Can be started here</option>
										<option value="use">Only continue ones started elsewhere</option>
									</select>
								)}
							</li>
						);
					})}
					{gone.map((id) => (
						<li key={id} className="flex items-center gap-3 px-3 py-2 text-sm text-fg-muted">
							<input type="checkbox" className="h-5 w-5" checked disabled={!canEdit} onChange={() => toggle(id)} />
							<span className="min-w-0 truncate">No longer in the hub ({id.slice(0, 8)}…)</span>
						</li>
					))}
					{!templates.length && <li className="px-3 py-2 text-sm text-fg-muted">No checklists yet. Download them under Checklist setup.</li>}
				</ul>
			)}
		</div>
	);
}

function JoinPanel({ station, minted, base, setBase, canEdit, onMint, onRevoke }: { station: StationView; minted?: Minted; base: string; setBase: (b: string) => void; canEdit: boolean; onMint: () => void; onRevoke: () => void }) {
	const label = `${station.location ? `${station.location} · ` : ""}${station.name}`;
	const path = minted?.path ?? station.join?.path;
	const url = path ? `${base.replace(/\/$/, "")}${path}` : undefined;
	const [copied, setCopied] = useState(false);

	const print = () => {
		if (!url) return;
		let svg: string;
		try {
			svg = qrToSvg(encodeQr(url), { moduleSize: 8 });
		} catch {
			return;
		}
		const w = window.open("", "_blank");
		if (!w) return;
		const esc = (t: string) => t.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch] as string);
		w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(label)}</title><style>@page{margin:2cm}body{font-family:system-ui,sans-serif;text-align:center;color:#000;background:#fff;margin:0;padding:2rem}h1{font-size:2.2rem;margin:0 0 .25rem}p{margin:.25rem 0;color:#333}svg{width:min(80vw,60vh);height:auto;margin:1.5rem auto}code{font-size:.8rem;color:#666;word-break:break-all}</style></head><body><h1>${esc(label)}</h1><p>Scan to open Flow Voice on this station</p>${svg}<p><code>${esc(url)}</code></p><script>window.onload=function(){window.print()}</script></body></html>`);
		w.document.close();
	};

	return (
		<div className="border-t border-line p-4 md:w-72 md:border-t-0 md:border-l">
			<p className="flex items-center gap-1.5 text-sm font-semibold">
				<Icon name="qr" size={16} /> Open this station
			</p>
			{station.join ? (
				<p className="mt-1 text-xs text-fg-muted">Scan with the phone or tablet, or open the link on a PC.</p>
			) : (
				<p className="mt-1 text-xs text-fg-muted">Save the station to get its link.</p>
			)}
			{url ? (
				<div className="mt-3 space-y-2">
					<QrCode text={url} size={208} className="mx-auto block border border-line" />
					<div className="grid grid-cols-2 gap-2">
						<a className="btn btn-sm btn-primary col-span-2" href={url} target="_blank" rel="noreferrer">
							Open on this computer
						</a>
						<button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true))}>
							{copied ? "Copied" : "Copy link"}
						</button>
						<button type="button" className="btn btn-sm" onClick={print}>
							Print poster
						</button>
					</div>
				</div>
			) : (
				<button type="button" className="btn btn-sm btn-primary mt-3" disabled={!canEdit} onClick={onMint}>
					Show link and QR code
				</button>
			)}
			{url && (
				<details className="mt-3 text-xs text-fg-muted">
					<summary className="cursor-pointer">Link lost or shared by mistake?</summary>
					<p className="mt-2">Make a new link. The old link and printed posters stop working. Devices already in use stay signed in.</p>
					<button type="button" className="btn btn-sm mt-2" disabled={!canEdit} onClick={() => confirm("Make a new link? The old link and printed QR codes stop working.") && onMint()}>
						Make a new link
					</button>
					<label className="label mt-3">Web address on the poster</label>
					<input className="input mono" value={base} onChange={(e) => setBase(e.target.value)} />
					<p className="mono mt-2 break-all text-[11px] text-fg-faint">{url}</p>
				</details>
			)}
		</div>
	);
}
