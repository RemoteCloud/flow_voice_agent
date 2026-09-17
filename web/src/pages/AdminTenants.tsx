import { useCallback, useEffect, useState } from "react";
import type { TenantsResponse } from "../../../server/tenants.js";
import { api, toApiError } from "../api.js";

/** Leave or enter a tenant, then load the app again so every screen belongs to the new tenant. */
export async function switchTenant(id: string | undefined): Promise<void> {
	await api.post(id ? `tenants/${encodeURIComponent(id)}/enter` : "tenants/leave");
	location.assign("/admin");
}

/** Admin → Tenants (main hub admins): try another Maranics tenant with a pasted access token. */
export function TenantsTab() {
	const [data, setData] = useState<TenantsResponse | undefined>();
	const [err, setErr] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const [name, setName] = useState("");
	const [tenant, setTenant] = useState("");
	const [token, setToken] = useState("");
	const [host, setHost] = useState("");
	const [replace, setReplace] = useState<{ id: string; token: string } | undefined>();

	const load = useCallback(() => api.get<TenantsResponse>("tenants").then(setData, (e) => setErr(toApiError(e).message)), []);
	useEffect(() => {
		void load();
	}, [load]);
	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setErr(undefined);
		try {
			await fn();
			await load();
		} catch (e) {
			setErr(toApiError(e).message);
		} finally {
			setBusy(false);
		}
	};
	const add = () =>
		run(async () => {
			await api.post("tenants", { name, tenant, token, host: host || undefined });
			setName("");
			setTenant("");
			setToken("");
			setHost("");
		});

	if (!data) return <p className="text-sm text-fg-muted">{err ?? "Loading…"}</p>;
	const expired = (iso?: string) => !!iso && Date.parse(iso) < Date.now();
	return (
		<div className="space-y-4">
			{err && <p className="text-sm text-danger">{err}</p>}
			<section className="card">
				<div className="card-head">
					<div>
						<h2 className="card-title">You are in: {data.current ? data.current.name : `${data.mainName} (main hub)`}</h2>
						<p className="text-xs text-fg-muted">Each tenant has its own stations, checklists, answer words and runs. Nothing is shared.</p>
					</div>
					{data.current && (
						<button type="button" className="btn btn-sm btn-primary" onClick={() => void switchTenant(undefined)}>
							Back to the main hub
						</button>
					)}
				</div>
			</section>

			{!data.canManage ? (
				data.central ? (
					<p className="px-1 text-sm text-fg-muted">
						Tenants are added, opened and removed in the{" "}
						<a className="underline" href="/central">
							central admin area
						</a>
						. It has its own password.
					</p>
				) : (
					<p className="px-1 text-sm text-fg-muted">Tenants are added and switched by an admin of the main hub. Go back to the main hub to manage them.</p>
				)
			) : (
				<>
					<section className="card">
						<div className="card-head">
							<h2 className="card-title">Tenants to try</h2>
						</div>
						<ul className="divide-y divide-line">
							{data.tenants.map((t) => (
								<li key={t.id} className="space-y-2 px-4 py-3 text-sm">
									<div className="flex flex-wrap items-center gap-2">
										<span className="min-w-0 flex-1 basis-48">
											<span className="block truncate font-medium">{t.name}</span>
											<span className="block truncate text-xs text-fg-faint">
												{t.tenant}
												{t.host ? ` · ${t.host.replace(/^https?:\/\//, "")}` : ""} · token …{t.tokenHint}
												{t.tokenExpiresAt && <span className={expired(t.tokenExpiresAt) ? "text-danger" : ""}> · {expired(t.tokenExpiresAt) ? "expired" : "valid until"} {new Date(t.tokenExpiresAt).toLocaleString()}</span>}
											</span>
										</span>
										<button type="button" className="btn btn-sm btn-primary" disabled={busy || data.current?.id === t.id} onClick={() => void switchTenant(t.id)}>
											{data.current?.id === t.id ? "You are here" : "Open"}
										</button>
										<button type="button" className="btn btn-sm" disabled={busy} onClick={() => setReplace(replace?.id === t.id ? undefined : { id: t.id, token: "" })}>
											New token
										</button>
										<button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => confirm(`Remove "${t.name}"? Its station links stop working. Its data stays on the server.`) && void run(() => api.del(`tenants/${encodeURIComponent(t.id)}`))}>
											Remove
										</button>
									</div>
									{replace?.id === t.id && (
										<div className="flex flex-wrap gap-2">
											<textarea className="input mono min-w-0 flex-1 basis-64 text-xs" rows={2} placeholder="Paste the new access token" value={replace.token} onChange={(e) => setReplace({ id: t.id, token: e.target.value })} />
											<button type="button" className="btn btn-sm btn-primary self-start" disabled={busy || !replace.token.trim()} onClick={() => void run(() => api.put(`tenants/${encodeURIComponent(t.id)}/token`, { token: replace.token })).then(() => setReplace(undefined))}>
												Save token
											</button>
										</div>
									)}
								</li>
							))}
							{!data.tenants.length && <li className="px-4 py-3 text-sm text-fg-muted">No extra tenants yet.</li>}
						</ul>
					</section>

					<section className="card">
						<div className="card-head">
							<div>
								<h2 className="card-title">Add a tenant</h2>
								<p className="text-xs text-fg-muted">Paste an access token of a user in that tenant. Everything done in the tenant is written to Maranics as that user. When the token expires, paste a new one.</p>
							</div>
						</div>
						<form
							className="card-body grid gap-3 sm:grid-cols-2"
							onSubmit={(e) => {
								e.preventDefault();
								void add();
							}}
						>
							<div>
								<label className="label">Name</label>
								<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Color Line test" />
							</div>
							<div>
								<label className="label">Maranics tenant id</label>
								<input className="input mono" value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="colorline" />
							</div>
							<div className="sm:col-span-2">
								<label className="label">Access token</label>
								<textarea className="input mono text-xs" rows={3} value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" />
							</div>
							<details className="sm:col-span-2">
								<summary className="cursor-pointer text-xs text-fg-muted">Different Maranics environment?</summary>
								<label className="label mt-2">API host (leave empty to use the main hub's)</label>
								<input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://api.cloud.maranics.com" />
							</details>
							<div className="sm:col-span-2">
								<button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !tenant.trim() || !token.trim()}>
									Add tenant
								</button>
							</div>
						</form>
					</section>
				</>
			)}
		</div>
	);
}
