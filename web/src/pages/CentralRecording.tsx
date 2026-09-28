import { useCallback, useEffect, useState } from "react";
import type { RecordingView } from "../../../server/tenants.js";
import { api, toApiError } from "../api.js";
import { Alert, SaveMark, type SaveState } from "../components/ui.js";

const size = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} kB`);

/**
 * Central switch for recording answers for training: hub-wide, and per tenant / location. A station records only
 * while this is on here *and* the station ticks "Record answers for training".
 */
export function RecordingSwitch() {
	const [data, setData] = useState<RecordingView | undefined>();
	const [err, setErr] = useState<string | undefined>();
	const [save, setSave] = useState<SaveState>("idle");

	const load = useCallback(() => api.get<RecordingView>("central/recording").then(setData, (e) => setErr(toApiError(e).message)), []);
	useEffect(() => {
		void load();
	}, [load]);

	const put = async (body: { enabled?: boolean; core?: string; allowed?: boolean }) => {
		setSave("saving");
		setErr(undefined);
		try {
			setData(await api.put<RecordingView>("central/recording", body));
			setSave("saved");
		} catch (e) {
			setErr(toApiError(e).message);
			setSave("idle");
		}
	};

	if (!data) return err ? <Alert>{err}</Alert> : null;
	return (
		<section className="card">
			<div className="card-head">
				<div>
					<h2 className="card-title">Recording answers for training</h2>
					<p className="text-xs text-fg-muted">The voice of each answer is kept with its checklist and item and sent to the training store. A station records only when it is on here and ticked on the station (Admin → Stations).</p>
				</div>
				<SaveMark state={save} />
			</div>
			<div className="card-body space-y-3 text-sm">
				{err && <Alert>{err}</Alert>}
				<label className="flex items-center gap-2 font-medium">
					<input type="checkbox" className="h-5 w-5" checked={data.enabled} onChange={(e) => void put({ enabled: e.target.checked })} />
					Allow recording on this hub
				</label>
				<ul className="divide-y divide-line rounded-lg border border-line">
					{data.cores.map((c) => (
						<li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
							<label className="flex min-w-0 flex-1 items-center gap-2">
								<input type="checkbox" className="h-5 w-5" checked={c.allowed} disabled={!data.enabled} onChange={(e) => void put({ core: c.id, allowed: e.target.checked })} />
								<span className="truncate">{c.id === "main" ? `${c.name} (main hub)` : c.name}</span>
							</label>
							<span className="text-xs text-fg-muted">
								{c.stations ? `${c.stations} station${c.stations === 1 ? "" : "s"} ticked` : "no station ticked"}
								{c.status ? ` · ${c.status.target === "s3" ? `${c.status.uploaded} sent to ${c.status.bucket}` : "kept on the hub (no bucket)"}${c.status.queued ? ` · ${c.status.queued} waiting (${size(c.status.queuedBytes)})` : ""}` : ""}
							</span>
							{c.status?.lastError && <span className="w-full text-xs text-danger">Last upload failed: {c.status.lastError}</span>}
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
