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
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [issuer, setIssuer] = useState("");
	const [copied, setCopied] = useState<string | undefined>();
	const [replace, setReplace] = useState<{ id: string; clientId: string; clientSecret: string } | undefined>();

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
			await api.post("tenants", { name, tenant, clientId: clientId || undefined, clientSecret: clientSecret || undefined, issuer: issuer || undefined, token: token || undefined, host: host || undefined });
			setClientId("");
			setClientSecret("");
			setIssuer("");
			setName("");
			setTenant("");
			setToken("");
			setHost("");
		});

	if (!data) return <p className="text-sm text-fg-muted">{err ?? "Loading…"}</p>;
	const expired = (iso?: string) => !!iso && Date.parse(iso) < Date.now();
	const callback = `${location.origin}/api/auth/callback`;
	const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => setCopied(text), () => undefined);
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
												{t.host ? ` · ${t.host.replace(/^https?:\/\//, "")}` : ""} · {t.mode === "sso" ? `Maranics sign-in · client ${t.clientId}` : `pasted token …${t.tokenHint}`}
												{t.tokenExpiresAt && <span className={expired(t.tokenExpiresAt) ? "text-danger" : ""}> · {expired(t.tokenExpiresAt) ? "expired" : "valid until"} {new Date(t.tokenExpiresAt).toLocaleString()}</span>}
											</span>
										</span>
										<button type="button" className="btn btn-sm btn-primary" disabled={busy || data.current?.id === t.id} onClick={() => void switchTenant(t.id)}>
											{data.current?.id === t.id ? "You are here" : "Open"}
										</button>
										<button type="button" className="btn btn-sm" disabled={busy} onClick={() => setReplace(replace?.id === t.id ? undefined : { id: t.id, clientId: t.clientId ?? "", clientSecret: "" })}>
											New client secret
										</button>
										<button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => confirm(`Remove "${t.name}"? Its station links stop working. Its data stays on the server.`) && void run(() => api.del(`tenants/${encodeURIComponent(t.id)}`))}>
											Remove
										</button>
									</div>
									{t.loginPath && (
										<div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
											<span>Sign-in link for this tenant:</span>
											<span className="mono min-w-0 truncate">{location.origin + t.loginPath}</span>
											<button type="button" className="btn btn-sm" onClick={() => copy(location.origin + t.loginPath)}>
												{copied === location.origin + t.loginPath ? "Copied ✓" : "Copy"}
											</button>
										</div>
									)}
									{replace?.id === t.id && (
										<div className="flex flex-wrap gap-2">
											<input className="input mono min-w-0 flex-1 basis-40 text-xs" placeholder="Client id" value={replace.clientId} onChange={(e) => setReplace({ ...replace, clientId: e.target.value })} />
											<input className="input mono min-w-0 flex-1 basis-56 text-xs" type="password" autoComplete="off" placeholder="New client secret" value={replace.clientSecret} onChange={(e) => setReplace({ ...replace, clientSecret: e.target.value })} />
											<button type="button" className="btn btn-sm btn-primary self-start" disabled={busy || !replace.clientId.trim() || !replace.clientSecret.trim()} onClick={() => void run(() => api.put(`tenants/${encodeURIComponent(t.id)}/client`, { clientId: replace.clientId, clientSecret: replace.clientSecret })).then(() => setReplace(undefined))}>
												Save
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
								<p className="text-xs text-fg-muted">Each tenant signs in with Maranics through its own client. People sign in as themselves; the first one to sign in becomes that tenant's admin.</p>
								<p className="mt-1 text-xs text-fg-muted">
									Register this return address on the tenant's client: <span className="mono">{callback}</span>{" "}
									<button type="button" className="underline" onClick={() => copy(callback)}>
										{copied === callback ? "copied ✓" : "copy"}
									</button>
								</p>
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
							<div>
								<label className="label">Client id</label>
								<input className="input mono" autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="flowvoice-colorline" />
							</div>
							<div>
								<label className="label">Client secret</label>
								<input className="input mono" type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
							</div>
							<div className="sm:col-span-2">
								<label className="label">Maranics server address</label>
								<input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder={data.mainHost ?? "https://api.cloud.maranics.com"} />
								<p className="help">Where this tenant lives. Leave empty for the same server as the main hub{data.mainHost ? ` (${data.mainHost.replace(/^https?:\/\//, "")})` : ""}. Sign-in is found from it.</p>
							</div>
							<details className="sm:col-span-2">
								<summary className="cursor-pointer text-xs text-fg-muted">Sign-in on another address, or no client yet?</summary>
								<label className="label mt-2">Sign-in address (issuer). Leave empty: worked out from the server address and tenant id</label>
								<input className="input mono" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://um.cloud.maranics.com/colorline" />
								<label className="label mt-2">No client yet: paste an access token instead. Everyone then acts as that user, until it expires</label>
								<textarea className="input mono text-xs" rows={2} value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" />
							</details>
							<div className="sm:col-span-2">
								<button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !tenant.trim() || !((clientId.trim() && clientSecret.trim()) || token.trim())}>
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
