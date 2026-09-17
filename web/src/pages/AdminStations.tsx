import { useEffect, useState } from "react";
import type { JoinTokenResponse, Station, StationView, StatusResponse, VoiceProfile } from "../../../server/api.js";
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

	useEffect(() => {
		api.get<VoiceProfile[]>("profiles").then(setProfiles, () => setProfiles([]));
	}, []);
	// pick up server-side changes (another admin, portable files) while nothing is being edited here
	useEffect(() => {
		if (!dirty) setRows(s.stations.map(strip));
	}, [s.stations, dirty]);

	const edit = (i: number, patch: Partial<Station>) => {
		setRows((r) => r.map((st, k) => (k === i ? { ...st, ...patch } : st)));
		setDirty(true);
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
				return (
					<section key={`${st.stationId}-${i}`} className="card">
						<div className="card-head">
							<h2 className="card-title">
								{st.location ? `${st.location} · ` : ""}
								{st.name || st.stationId}
							</h2>
							<div className="flex items-center gap-3 text-xs text-fg-faint">
								{live?.endpoint ? <span className="text-ok">endpoint online</span> : <span>no endpoint</span>}
								<button type="button" className="btn btn-sm btn-danger" disabled={!canEdit} onClick={() => setRows((r) => (setDirty(true), r.filter((_, k) => k !== i)))}>
									Remove
								</button>
							</div>
						</div>
						<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
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
									<select className="input" value={st.language} disabled={!canEdit} onChange={(e) => edit(i, { language: e.target.value })}>
										{LANGS.map((l) => (
											<option key={l} value={l}>
												{l}
											</option>
										))}
									</select>
								</div>
								<div>
									<label className="label">Audio policy</label>
									<select className="input" value={st.audioPolicy} disabled={!canEdit} onChange={(e) => edit(i, { audioPolicy: e.target.value === "open" ? "open" : "ptt" })}>
										<option value="ptt">Push to talk</option>
										<option value="open">Open mic (hands-free, voice auto-starts)</option>
									</select>
								</div>
								<div>
									<label className="label">Verbosity</label>
									<select className="input" value={st.verbosity ?? "full"} disabled={!canEdit} onChange={(e) => edit(i, { verbosity: e.target.value as Station["verbosity"] })}>
										<option value="full">Full</option>
										<option value="short">Short</option>
										<option value="silent">Silent</option>
									</select>
								</div>
								<div>
									<label className="label">Default profile</label>
									<select className="input" value={st.defaultProfile ?? ""} disabled={!canEdit} onChange={(e) => edit(i, { defaultProfile: e.target.value || null })}>
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
										<input type="checkbox" checked={st.voiceActions !== false} disabled={!canEdit} onChange={(e) => edit(i, { voiceActions: e.target.checked })} />
										Complete / discard by voice (two-step)
									</label>
									<label className="flex items-center gap-2">
										<input type="checkbox" checked={!!st.holdToAnswer} disabled={!canEdit} onChange={(e) => edit(i, { holdToAnswer: e.target.checked })} />
										Hold to answer on phones / tablets (noisy place)
									</label>
									<label className="flex items-center gap-2">
										<input type="checkbox" checked={!!st.autoStartAllowed} disabled={!canEdit} onChange={(e) => edit(i, { autoStartAllowed: e.target.checked })} />
										Triggered runs may start unattended
									</label>
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

function JoinPanel({ station, minted, base, setBase, canEdit, onMint, onRevoke }: { station: StationView; minted?: Minted; base: string; setBase: (b: string) => void; canEdit: boolean; onMint: () => void; onRevoke: () => void }) {
	const label = `${station.location ? `${station.location} · ` : ""}${station.name}`;
	const url = minted ? `${base.replace(/\/$/, "")}${minted.path}` : undefined;
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
				<Icon name="qr" size={16} /> Station QR code
			</p>
			{station.join ? (
				<p className="mt-1 text-xs text-fg-muted">
					Active · …{station.join.tokenHint} · {new Date(station.join.createdAt).toLocaleString()}
				</p>
			) : (
				<p className="mt-1 text-xs text-fg-muted">No QR code yet.</p>
			)}
			{minted && url ? (
				<div className="mt-3 space-y-2">
					<QrCode text={url} size={208} className="mx-auto block border border-line" />
					<p className="text-xs text-warn">Shown once. Print or copy it now — after reload only the hint remains.</p>
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
					{station.join ? "Rotate" : "Create QR"}
				</button>
				{station.join && (
					<button type="button" className="btn btn-sm btn-danger" disabled={!canEdit} onClick={onRevoke}>
						Revoke
					</button>
				)}
			</div>
			<p className="help mt-3">Any number of phones can scan one poster: each is locked to this station and then signs in as its own user. Rotating or revoking does not sign out phones already joined. The link opens the client (/client) on any device: phone, tablet, PC or Raspberry Pi.</p>
		</div>
	);
}
