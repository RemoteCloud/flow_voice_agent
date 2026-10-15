import { useEffect, useState } from "react";
import type { StationView, StatusResponse } from "../../../server/api.js";
import { api } from "../api.js";
import { useApp } from "../context.js";
import { AUTO_VOICE, deviceVoices, previewVoice, seenVoices, setDeviceVoice, VOICE_LANG_NAMES, VOICE_LANGS, voiceLang, voiceOptions, type VoiceOption } from "../voices.js";
import { Alert, SaveMark, type SaveState } from "./ui.js";

/** What a voice id is called on screen. */
export function voiceName(id: string | undefined, options: VoiceOption[] = []): string {
	if (!id || id === AUTO_VOICE) return "automatic";
	return options.find((o) => o.id === id)?.label ?? (id.startsWith("hub:") ? `${id.slice(4)} (hub)` : id);
}

/** One language: a voice list (with what to show for "nothing picked") and a button that reads a sample with the voice. */
function VoiceRow({ lang, value, onChange, options, first, heard }: { lang: string; value: string; onChange: (id: string) => void; options: { label: string; list: VoiceOption[] }[]; first: { id: string; label: string }[]; heard: string | undefined }) {
	const [err, setErr] = useState<string | undefined>();
	const known = options.some((g) => g.list.some((o) => o.id === value)) || first.some((f) => f.id === value);
	return (
		<div className="space-y-1">
			<div className="flex flex-wrap items-center gap-2">
				<span className="w-24 shrink-0 text-sm font-medium">{VOICE_LANG_NAMES[lang] ?? lang}</span>
				<select className="input min-w-0 flex-1" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`Voice for ${VOICE_LANG_NAMES[lang] ?? lang}`}>
					{first.map((f) => (
						<option key={f.id} value={f.id}>
							{f.label}
						</option>
					))}
					{!known && value && <option value={value}>{voiceName(value)} (not on this device)</option>}
					{options
						.filter((g) => g.list.length)
						.map((g) => (
							<optgroup key={g.label} label={g.label}>
								{g.list.map((o) => (
									<option key={`${g.label}:${o.id}`} value={o.id}>
										{o.label}
									</option>
								))}
							</optgroup>
						))}
				</select>
				<button type="button" className="btn btn-sm" onClick={() => previewVoice(lang, heard).then(() => setErr(undefined), (e) => setErr(e instanceof Error ? e.message : String(e)))}>
					Listen
				</button>
			</div>
			{err && <Alert tone="warn">{err}</Alert>}
		</div>
	);
}

function useOptions(): Record<string, VoiceOption[]> {
	const { boot } = useApp();
	const [opts, setOpts] = useState<Record<string, VoiceOption[]>>({});
	useEffect(() => {
		let live = true;
		void Promise.all(VOICE_LANGS.map(async (l) => [l, await voiceOptions(l, boot.speech.ttsVoices)] as const)).then((all) => live && setOpts(Object.fromEntries(all)));
		return () => {
			live = false;
		};
	}, [boot.speech.ttsVoices]);
	return opts;
}

/**
 * Home → Voice: the person on this device picks the voice per language. Kept on this device only; "Admin's choice"
 * follows the default set in Admin → Status → Voices.
 */
export function VoiceSetup({ onClose, language }: { onClose: () => void; language?: string }) {
	const { boot } = useApp();
	const opts = useOptions();
	const [mine, setMine] = useState(deviceVoices);
	const [saved, setSaved] = useState<SaveState>("idle");
	const admin = boot.speech.voices ?? {};
	const first = language ? voiceLang(language) : undefined;
	const langs = first && (VOICE_LANGS as readonly string[]).includes(first) ? [first, ...VOICE_LANGS.filter((l) => l !== first)] : [...VOICE_LANGS];
	const change = (lang: string, id: string) => {
		setDeviceVoice(lang, id);
		setMine(deviceVoices());
		setSaved("saved");
	};
	return (
		<div className="fixed inset-0 z-20 flex items-end justify-center bg-black/60 p-3 sm:items-center" onClick={onClose}>
			<div className="card max-h-[90vh] w-full max-w-2xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
				<div className="card-head">
					<h3 className="card-title">Voice on this device</h3>
					<SaveMark state={saved} className="ml-auto mr-2" />
					<button type="button" className="btn btn-sm" onClick={onClose}>
						Done
					</button>
				</div>
				<div className="card-body space-y-3">
					<p className="text-sm text-fg-muted">The voice that reads the checklist, per language. Only this device changes.</p>
					{langs.map((l) => {
						const list = opts[l] ?? [];
						const value = mine[l] ?? "";
						return (
							<VoiceRow
								key={l}
								lang={l}
								value={value}
								onChange={(id) => change(l, id)}
								first={[
									{ id: "", label: `Admin's choice (${voiceName(admin[l], list)})` },
									...(admin[l] && admin[l] !== AUTO_VOICE ? [{ id: AUTO_VOICE, label: "Automatic" }] : []),
								]}
								options={[
									{ label: "The hub's voices", list: list.filter((o) => o.group === "hub") },
									{ label: "This device's voices", list: list.filter((o) => o.group === "device") },
								]}
								heard={value || admin[l]}
							/>
						);
					})}
					{!Object.values(opts).some((l) => l.length) && <Alert tone="info">Looking for the voices on this device…</Alert>}
				</div>
			</div>
		</div>
	);
}

/** Admin → Status → Voices: the default voice per language for every device. Saved at once; a device may pick another one. */
export function AdminVoices({ settings, stations, canEdit }: { settings: StatusResponse["settings"]; stations: StationView[]; canEdit: boolean }) {
	const opts = useOptions();
	const seen = seenVoices(stations);
	const [voices, setVoices] = useState<Record<string, string>>(settings.voices ?? {});
	const [state, setState] = useState<SaveState>("idle");
	const [err, setErr] = useState<string | undefined>();
	const change = (lang: string, id: string) => {
		const next = { ...voices };
		if (id) next[lang] = id;
		else delete next[lang];
		setVoices(next);
		setState("saving");
		api.put("settings", { voices: next }).then(
			() => (setErr(undefined), setState("saved")),
			(e) => (setState("idle"), setErr(e instanceof Error ? e.message : String(e))),
		);
	};
	return (
		<section className="card">
			<div className="card-head">
				<h2 className="card-title">Voices</h2>
				<SaveMark state={state} className="ml-auto" />
			</div>
			<div className="card-body space-y-3">
				<p className="text-sm text-fg-muted">The voice every device reads a checklist with, per language. The crew can pick another one on their device (Home → Voice). A voice a device does not have is replaced by its best voice for the language.</p>
				{VOICE_LANGS.map((l) => {
					const list = opts[l] ?? [];
					const here = list.filter((o) => o.group === "device");
					const others = (seen[l] ?? []).filter((n) => !here.some((o) => o.id === n)).map((n): VoiceOption => ({ id: n, label: n, group: "seen" }));
					return canEdit ? (
						<VoiceRow
							key={l}
							lang={l}
							value={voices[l] ?? ""}
							onChange={(id) => change(l, id)}
							first={[{ id: "", label: "Automatic (each device decides)" }]}
							options={[
								{ label: "The hub's voices (same on every device)", list: list.filter((o) => o.group === "hub") },
								{ label: "Voices on this computer", list: here },
								{ label: "Voices the station devices have", list: others },
							]}
							heard={voices[l]}
						/>
					) : (
						<p key={l} className="text-sm">
							{VOICE_LANG_NAMES[l]}: {voiceName(voices[l], list)}
						</p>
					);
				})}
				{err && <Alert>{err}</Alert>}
			</div>
		</section>
	);
}
