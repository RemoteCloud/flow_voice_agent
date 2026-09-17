import { useEffect, useState } from "react";
import type { ChecklistPick, JoinTokenResponse, LibraryView, Station, StationView, StatusResponse, VoiceProfile } from "../../../server/api.js";
import { encodeQr, qrToSvg } from "../../../server/core/qr.js";
import { api, toApiError } from "../api.js";
import { QrCode } from "../components/QrCode.js";
import { Icon } from "../icons.js";

const LANGS = ["en", "sv", "no", "fr", "de"];
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
	/** Selects and tick boxes save at once on a saved station, unless typed edits are still waiting for the Save button. */
	const pick = (i: number, patch: Partial<Station>) => {
		const isSaved = s.stations.some((x) => x.stationId === rows[i]?.stationId);
		if (dirty || !isSaved) return edit(i, patch);
		const next = rows.map((st, k) => (k === i ? { ...st, ...patch } : st));
		setRows(next);
		void save(next);
	};
	const save = async (list: Station[] = rows) => {
		try {
			await api.put("stations", list);
			setErr(undefined);
			setDirty(false);
			await reload();
		} catch (e) {
			setErr(toApiError(e).message);
		}
	};
	const applyJson = () => {
		try {
			const list = JSON.parse(text) as Station[];
			if (!Array.isArray(list)) throw new SyntaxError("expected an array");
			setRows(list);
			setDirty(true);
			setJson(false);
			setErr(undefined);
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
			<div className="flex flex-wrap items-center gap-2">
				<p className="text-xs text-fg-faint">Portable: the same list lives in /data/stations.json and can be copied to the next vessel. QR codes stay on this hub.</p>
				<div className="ml-auto flex gap-2">
					<button
						type="button"
						className="btn btn-sm btn-ghost"
						onClick={() => {
							setText(JSON.stringify(rows, null, 2));
							setJson((j) => !j);
						}}
					>
						{json ? "Hide JSON" : "Advanced JSON"}
					</button>
					<button type="button" className="btn btn-sm" disabled={!canEdit} onClick={() => edit(rows.length, { stationId: `station-${String(rows.length + 1).padStart(2, "0")}`, name: "New station", language: "en", audioPolicy: "ptt", autoStartAllowed: false, verbosity: "full", voiceActions: true, defaultProfile: null })}>
						+ Add station
					</button>
					<button type="button" className="btn btn-sm btn-primary" disabled={!canEdit || !dirty} onClick={() => void save()}>
						Save stations
					</button>
				</div>
			</div>
			<section className="card">
				<div className="card-head">
					<h2 className="card-title">New station with QR code</h2>
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
									{l}
								</option>
							))}
						</select>
					</div>
					<button type="submit" className="btn btn-primary" disabled={!canEdit || !newName.trim() || dirty} title={dirty ? "Save or discard the edits below first" : undefined}>
						Create + QR
					</button>
				</form>
				<p className="help px-4 pb-3">The QR code appears on the new station's card below: print it and scan it with the phone or tablet. The device is then locked to this station.</p>
			</section>
			{err && <p className="text-sm text-danger">{err}</p>}
			{json && (
				<section className="card">
					<div className="card-body space-y-2">
						<textarea className="input mono" rows={14} value={text} onChange={(e) => setText(e.target.value)} disabled={!canEdit} />
						<button type="button" className="btn btn-sm" disabled={!canEdit} onClick={applyJson}>
							Apply to the form
						</button>
					</div>
				</section>
			)}
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
								{!isOpen && <span className="truncate text-xs text-fg-faint">{st.language} · {nTpl ? `${nTpl} checklist(s)` : "all checklists"}</span>}
							</button>
							<div className="flex items-center gap-3 text-xs text-fg-faint">
								{live?.endpoint ? <span className="text-ok">endpoint online</span> : <span>no endpoint</span>}
								<button type="button" className="btn btn-sm btn-danger" disabled={!canEdit} onClick={() => setRows((r) => (setDirty(true), r.filter((_, k) => k !== i)))}>
									Remove
								</button>
							</div>
						</div>
						<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]" hidden={!isOpen}>
							<div className="card-body grid gap-3 sm:grid-cols-2">
								<div>
									<label className="label">Station id</label>
									<input className="input mono" value={st.stationId} readOnly={!isNew} disabled={!canEdit} onChange={(e) => edit(i, { stationId: e.target.value.trim() })} />
								</div>
								<div>
									<label className="label">Name</label>
									<input className="input" value={st.name} disabled={!canEdit} onChange={(e) => edit(i, { name: e.target.value })} />
								</div>
								<div>
									<label className="label">Location</label>
									<input className="input" value={st.location ?? ""} placeholder="e.g. Location 1, Deck 3" disabled={!canEdit} onChange={(e) => edit(i, { location: e.target.value || undefined })} />
									<p className="help">Shown before the name on phones and posters.</p>
								</div>
								<div>
									<label className="label">Language</label>
									<select className="input" value={st.language} disabled={!canEdit} onChange={(e) => pick(i, { language: e.target.value })}>
										{LANGS.map((l) => (
											<option key={l} value={l}>
												{l}
											</option>
										))}
									</select>
								</div>
								<div>
									<label className="label">Audio policy</label>
									<select className="input" value={st.audioPolicy} disabled={!canEdit} onChange={(e) => pick(i, { audioPolicy: e.target.value === "open" ? "open" : "ptt" })}>
										<option value="ptt">Push to talk</option>
										<option value="open">Open mic (hands-free, voice auto-starts)</option>
									</select>
								</div>
								<div>
									<label className="label">Verbosity</label>
									<select className="input" value={st.verbosity ?? "full"} disabled={!canEdit} onChange={(e) => pick(i, { verbosity: e.target.value as Station["verbosity"] })}>
										<option value="full">Full</option>
										<option value="short">Short</option>
										<option value="silent">Silent</option>
									</select>
								</div>
								<div>
									<label className="label">Default profile</label>
									<select className="input" value={st.defaultProfile ?? ""} disabled={!canEdit} onChange={(e) => pick(i, { defaultProfile: e.target.value || null })}>
										<option value="">None</option>
										{profiles.map((p) => (
											<option key={p.profileId} value={p.profileId}>
												{p.profileId}
											</option>
										))}
									</select>
								</div>
								<div className="flex flex-col justify-end gap-2 text-sm">
									<label className="flex items-center gap-2">
										<input type="checkbox" checked={st.voiceActions !== false} disabled={!canEdit} onChange={(e) => pick(i, { voiceActions: e.target.checked })} />
										Complete / discard by voice (two-step)
									</label>
									<label className="flex items-center gap-2">
										<input type="checkbox" checked={!!st.holdToAnswer} disabled={!canEdit} onChange={(e) => pick(i, { holdToAnswer: e.target.checked })} />
										Hold to answer on phones / tablets (noisy place)
									</label>
									<label className="flex items-center gap-2">
										<input type="checkbox" checked={!!st.autoStartAllowed} disabled={!canEdit} onChange={(e) => pick(i, { autoStartAllowed: e.target.checked })} />
										Triggered runs may start unattended
									</label>
								</div>
								<div className="sm:col-span-2">
							<TemplateRules rules={st.templates} templates={templates} stationLanguage={st.language} canEdit={canEdit} onChange={(t) => {
								// checklists save at once (no trip to the Save button) unless other edits are still pending
								const next = rows.map((x, k) => (k === i ? { ...x, templates: t } : x));
								setRows(next);
								if (isNew || dirty) setDirty(true);
								else void save(next);
							}} />
								</div>
							</div>
							{!isNew && <JoinPanel station={live} minted={minted[st.stationId]} base={base} setBase={setBase} canEdit={canEdit} onMint={() => void mint(st.stationId)} onRevoke={() => void revoke(st.stationId)} />}
						</div>
					</section>
				);
			})}
			{!rows.length && <p className="text-sm text-fg-muted">No stations. Add one above.</p>}
		</div>
	);
}

type Rules = NonNullable<Station["templates"]>;
const LANG_NAMES: Record<string, string> = { en: "English", no: "Norsk", sv: "Svenska", de: "Deutsch", fr: "Français" };

/** Per station: add the checklists used here; each one can be started or only worked on, in its own language. */
function TemplateRules({ rules, templates, stationLanguage, canEdit, onChange }: { rules: Station["templates"]; templates: ChecklistPick[] | undefined; stationLanguage: string; canEdit: boolean; onChange: (r: Station["templates"]) => void }) {
	const r: Rules = rules ?? {};
	const ids = Object.keys(r);
	const [pick, setPick] = useState("");
	const nameOf = (id: string) => templates?.find((t) => t.templateId === id)?.templateName ?? id;
	const put = (next: Rules) => onChange(Object.keys(next).length ? next : undefined);
	const set = (id: string, patch: Rules[string]) => {
		const rule = { ...r[id], ...patch };
		if (!rule.language) delete rule.language;
		put({ ...r, [id]: rule });
	};
	const remove = (id: string) => {
		const next = { ...r };
		delete next[id];
		put(next);
	};
	const add = () => {
		if (!pick) return;
		put({ ...r, [pick]: { access: "start" } });
		setPick("");
	};
	const free = (templates ?? []).filter((t) => !(t.templateId in r));
	const langOptions = (
		<>
			<option value="">Station language ({stationLanguage})</option>
			{LANGS.map((l) => (
				<option key={l} value={l}>
					{LANG_NAMES[l] ?? l}
				</option>
			))}
		</>
	);
	return (
		<div className="rounded-lg border border-line">
			<div className="px-3 py-2">
				<h3 className="text-sm font-medium">Checklists on this station</h3>
				<p className="text-xs text-fg-muted">{ids.length ? "Only the checklists added here are available on this station. Changes here are saved at once." : "Nothing added: every checklist of the hub (Admin → Checklist setup) is available here. Add checklists to limit this station to them. Language and answer words are set centrally under Checklist setup."}</p>
			</div>
			{ids.length > 0 && (
				<ul className="divide-y divide-line border-t border-line">
					{ids.map((id) => (
						<li key={id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
							<span className="min-w-0 flex-1 basis-40 truncate">{nameOf(id)}</span>
							<select className="input w-auto py-1 text-xs" value={r[id]?.access === "use" ? "use" : r[id]?.access === "off" ? "off" : "start"} disabled={!canEdit} onChange={(e) => set(id, { access: e.target.value as Rules[string]["access"] })} title="Start and use: start button here. Use only: open ones started elsewhere can be worked on here, no start button.">
								<option value="start">Start and use</option>
								<option value="use">Use only</option>
								{r[id]?.access === "off" && <option value="off">Not here</option>}
							</select>
							<span className="text-xs text-fg-faint">{templates?.find((t) => t.templateId === id)?.language ?? "station language"}</span>
							<button type="button" className="btn btn-sm btn-ghost" disabled={!canEdit} onClick={() => remove(id)}>
								Remove
							</button>
						</li>
					))}
				</ul>
			)}
			<div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
				<select className="input min-w-0 flex-1 basis-40 py-1 text-sm" value={pick} disabled={!canEdit || !templates} onChange={(e) => setPick(e.target.value)}>
					<option value="">{!templates ? "Loading checklists…" : free.length ? "Add a checklist…" : "All checklists added"}</option>
					{free.map((t) => (
						<option key={t.templateId} value={t.templateId}>
							{t.templateName}
						</option>
					))}
				</select>
				<button type="button" className="btn btn-sm btn-primary" disabled={!canEdit || !pick} onClick={add}>
					Add
				</button>
			</div>
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
				<Icon name="qr" size={16} /> Station link & QR code
			</p>
			{station.join ? (
				<p className="mt-1 text-xs text-fg-muted">
					Active · …{station.join.tokenHint} · {new Date(station.join.createdAt).toLocaleString()}
				</p>
			) : (
				<p className="mt-1 text-xs text-fg-muted">Save the station to get its link.</p>
			)}
			{url ? (
				<div className="mt-3 space-y-2">
					<QrCode text={url} size={208} className="mx-auto block border border-line" />
					<p className="text-xs text-fg-muted">This station's own link. Open it on a PC, Mac or Raspberry Pi, or scan the QR code with a phone or tablet: the device is then locked to this station.</p>
					<div>
						<label className="label">Base URL on the poster</label>
						<input className="input mono" value={base} onChange={(e) => setBase(e.target.value)} />
					</div>
					<p className="mono break-all text-[11px] text-fg-faint">{url}</p>
					<div className="flex flex-wrap gap-2">
						<button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true))}>
							{copied ? "Copied" : "Copy link"}
						</button>
						<button type="button" className="btn btn-sm" onClick={print}>
							Print
						</button>
					</div>
				</div>
			) : null}
			<div className="mt-3 flex flex-wrap gap-2">
				<button type="button" className="btn btn-sm btn-primary" disabled={!canEdit} onClick={onMint}>
					{station.join ? (station.join.path ? "New link (old one stops working)" : "Rotate to show the link") : "Create link"}
				</button>
			</div>
			<p className="help mt-3">Any number of phones can scan one poster: each is locked to this station and then signs in as its own user. A new link does not sign out devices already joined. The link opens the client (/client) on any device: phone, tablet, PC or Raspberry Pi.</p>
		</div>
	);
}
