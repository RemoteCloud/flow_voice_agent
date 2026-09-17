import { useEffect, useState } from "react";
import type { ChecklistPick, StatusResponse } from "../../../server/api.js";
import { api, toApiError } from "../api.js";

type Item = { key: string; name: string; section?: string; type?: string };
type Answers = Record<string, string[]>;

const parse = (text: string): string[] => [...new Set(text.split(",").map((w) => w.trim()).filter(Boolean))];

/** Admin → Answers: per checklist item, the words that count as its answer ("up", "closed"). */
export function AnswersTab({ s, reload, canEdit }: { s: StatusResponse; reload: () => Promise<void>; canEdit: boolean }) {
	const [templates, setTemplates] = useState<ChecklistPick[] | undefined>();
	const [templateId, setTemplateId] = useState("");
	const [items, setItems] = useState<Item[] | undefined>();
	const [draft, setDraft] = useState<Record<string, string>>({});
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | undefined>();

	useEffect(() => {
		api.get<ChecklistPick[]>("checklists").then(
			(p) => setTemplates(p.filter((x) => x.source === "template")),
			(e) => setErr(toApiError(e).message),
		);
	}, []);
	useEffect(() => {
		setItems(undefined);
		setDirty(false);
		if (!templateId) return;
		const saved: Answers = s.settings.itemAnswers?.[templateId] ?? {};
		setDraft(Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, v.join(", ")])));
		api.get<Item[]>(`template-items?templateId=${encodeURIComponent(templateId)}`).then(setItems, (e) => {
			setErr(toApiError(e).message);
			setItems([]);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [templateId]);

	const save = async () => {
		setBusy(true);
		setErr(undefined);
		try {
			const per: Answers = {};
			for (const [k, text] of Object.entries(draft)) if (parse(text).length) per[k] = parse(text);
			await api.put("settings", { itemAnswers: { ...(s.settings.itemAnswers ?? {}), [templateId]: per } });
			await reload();
			setDirty(false);
		} catch (e) {
			setErr(toApiError(e).message);
		} finally {
			setBusy(false);
		}
	};
	const count = (id: string) => Object.keys(s.settings.itemAnswers?.[id] ?? {}).length;

	return (
		<section className="card">
			<div className="card-head">
				<div>
					<h2 className="card-title">Answers per item</h2>
					<p className="text-xs text-fg-muted">Write the word(s) the crew answers with, for example "up" for Ramp. Any answer that contains the word is accepted ("the ramp is up"). Several words: separate with commas. Yes / no and the normal answers still work.</p>
				</div>
				<button type="button" className="btn btn-sm btn-primary" disabled={!canEdit || !dirty || busy} onClick={() => void save()}>
					Save answers
				</button>
			</div>
			<div className="card-body space-y-3">
				<select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!templates || (dirty && !busy)}>
					<option value="">{templates ? "Choose a checklist…" : "Loading checklists…"}</option>
					{templates?.map((t) => (
						<option key={t.templateId} value={t.templateId}>
							{t.templateName}
							{count(t.templateId) ? ` · ${count(t.templateId)} set` : ""}
						</option>
					))}
				</select>
				{dirty && <p className="text-xs text-warn">Unsaved changes. Save before choosing another checklist.</p>}
				{err && <p className="text-sm text-danger">{err}</p>}
			</div>
			{templateId &&
				(!items ? (
					<p className="card-body text-sm text-fg-muted">Loading items…</p>
				) : (
					<ul className="divide-y divide-line border-t border-line">
						{items.map((it, i) => (
							<li key={`${it.key}-${i}`} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
								<span className="min-w-0 flex-1 basis-48">
									<span className="block truncate">{it.name}</span>
									<span className="block truncate text-xs text-fg-faint">
										{it.section ? `${it.section} · ` : ""}
										{it.type ?? "Text"}
									</span>
								</span>
								<input
									className="input mono w-auto min-w-0 flex-1 basis-40 py-1 uppercase"
									placeholder="e.g. up"
									value={draft[it.key] ?? ""}
									disabled={!canEdit || busy}
									onChange={(e) => {
										setDraft((d) => ({ ...d, [it.key]: e.target.value }));
										setDirty(true);
									}}
								/>
							</li>
						))}
						{!items.length && <li className="px-4 py-3 text-sm text-fg-muted">No items found in this checklist.</li>}
					</ul>
				))}
		</section>
	);
}
