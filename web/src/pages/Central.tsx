import { useCallback, useEffect, useState } from "react";
import { api, toApiError } from "../api.js";
import { useDayNight } from "../theme.js";
import { TenantsTab } from "./AdminTenants.js";

interface CentralMe {
	configured: boolean;
	signedIn: boolean;
	mainName: string;
}

/** `/central`: the password-protected area where tenants are added. It has its own sign-in, separate from every tenant's. */
export function Central() {
	const [me, setMe] = useState<CentralMe | undefined>();
	const [err, setErr] = useState<string | undefined>();
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [dark, toggle] = useDayNight();

	const load = useCallback(() => api.get<CentralMe>("central/me").then(setMe, (e) => setErr(toApiError(e).message)), []);
	useEffect(() => {
		document.title = "Flow Voice · Central admin";
		void load();
	}, [load]);

	const signIn = async () => {
		setBusy(true);
		setErr(undefined);
		try {
			await api.post("central/login", { password });
			setPassword("");
			await load();
		} catch (e) {
			setErr(toApiError(e).message);
		} finally {
			setBusy(false);
		}
	};
	const signOut = async () => {
		await api.post("central/logout").catch(() => undefined);
		await load();
	};

	return (
		<div className="min-h-dvh bg-bg text-fg">
			<header className="border-b border-line">
				<div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2 px-4 py-3">
					<h1 className="min-w-0 flex-1 text-base font-semibold">Flow Voice · Central admin</h1>
					<button type="button" className="btn btn-sm" onClick={toggle}>
						{dark ? "Day" : "Night"}
					</button>
					<a className="btn btn-sm" href="/admin">
						Hub admin
					</a>
					{me?.signedIn && (
						<button type="button" className="btn btn-sm" onClick={() => void signOut()}>
							Sign out
						</button>
					)}
				</div>
			</header>
			<main className="mx-auto max-w-4xl px-4 py-6">
				{!me ? (
					<p className="text-sm text-fg-muted">{err ?? "Loading…"}</p>
				) : !me.configured ? (
					<section className="card">
						<div className="card-body space-y-2 text-sm">
							<h2 className="card-title">No password set yet</h2>
							<p className="text-fg-muted">
								Set <span className="mono">CENTRAL_PASSWORD</span> (12 characters or more) in the hub's environment and restart it. Until then, admins of the main hub manage tenants under Admin, Tenants.
							</p>
						</div>
					</section>
				) : !me.signedIn ? (
					<form
						className="card mx-auto max-w-sm"
						onSubmit={(e) => {
							e.preventDefault();
							void signIn();
						}}
					>
						<div className="card-body space-y-3">
							<h2 className="card-title">Sign in</h2>
							<p className="text-xs text-fg-muted">Tenants are added and removed here. This password is separate from every tenant's sign-in.</p>
							<div>
								<label className="label" htmlFor="central-pw">
									Password
								</label>
								<input id="central-pw" className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
							</div>
							{err && <p className="text-sm text-danger">{err}</p>}
							<button type="submit" className="btn btn-primary w-full" disabled={busy || !password}>
								Sign in
							</button>
						</div>
					</form>
				) : (
					<TenantsTab />
				)}
			</main>
		</div>
	);
}
