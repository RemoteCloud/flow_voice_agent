import { useEffect, useRef, useState } from "react";
import type { AuthProviderView, MeResponse } from "../../../server/api.js";
import { api, AUTH_LOGIN_URL, toApiError, type ApiClientError } from "../api.js";
import { versionLine } from "../build.js";
import { navigate } from "../router.js";

const AUTH_ERROR_TEXT: Record<string, string> = {
	provider_unavailable: "The identity provider could not be reached. Try again in a moment.",
	invalid_state: "This sign-in could not be matched to your browser. Start again from this page.",
	expired_state: "The sign-in took too long. Start again.",
	token_exchange_failed: "Maranics did not accept the sign-in (client id/secret or redirect URI mismatch).",
	invalid_token: "The identity token was rejected by the hub.",
	userinfo_failed: "Your user details could not be read from UserManagement.",
	not_allowed: "You signed in, but your position does not grant access to Flow Voice.",
	rate_limited: "Too many sign-in attempts from your address. Wait 15 minutes.",
	not_configured: "Sign-in is not configured on this hub.",
};

export function LoginPage(p: { provider?: AuthProviderView; hubVersion?: string; vesselId?: string; hubUrl?: string; authError?: string; notice?: string; probeError?: ApiClientError; joinStation?: { name: string; location?: string }; joinError?: string; onRetry: () => void; onDevSignedIn: (me: MeResponse) => void }) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | undefined>();
	const [showQr, setShowQr] = useState(false);
	const oidc = p.provider?.kind === "oidc" && p.provider.configured;
	const dev = !!p.provider?.devUserName;
	const auto = !!p.provider?.auto;

	const devLogin = async () => {
		setBusy(true);
		setErr(undefined);
		try {
			p.onDevSignedIn(await api.post<MeResponse>("auth/dev"));
		} catch (e) {
			setErr(toApiError(e).message);
		} finally {
			setBusy(false);
		}
	};

	// a token tenant has nothing to type: sign in straight away (once)
	const tried = useRef(false);
	useEffect(() => {
		if (!auto || tried.current) return;
		tried.current = true;
		void devLogin();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [auto]);

	return (
		<main className="flex min-h-screen items-center justify-center px-4 py-10">
			<div className="w-full max-w-md">
				<div className="mb-6 flex items-center gap-3">
					<img src="/icon.svg" width={36} height={36} alt="" />
					<div>
						<h1 className="text-xl font-semibold tracking-tight">Flow Voice</h1>
						<p className="text-sm text-fg-muted">Run Maranics Flow checklists by voice{p.vesselId ? ` — ${p.vesselId}` : ""}</p>
					</div>
				</div>
				{p.notice && (
					<p role="status" className="mb-4 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-sm text-info">
						{p.notice}
					</p>
				)}
				{p.joinStation && (
					<p role="status" className="mb-4 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
						Sign in to continue on <strong>{p.joinStation.location ? `${p.joinStation.location} · ` : ""}{p.joinStation.name}</strong>.
					</p>
				)}
				{p.joinError && (
					<div role="alert" className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
						<p className="font-medium text-warn">{p.joinError}</p>
						<p className="mt-1 text-fg-muted">Sign in and pick a station, or ask an administrator for a new code.</p>
					</div>
				)}
				{p.authError && (
					<div role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
						<p className="font-medium text-danger">Sign-in failed</p>
						<p className="mt-1 text-fg-muted">{AUTH_ERROR_TEXT[p.authError] ?? `Sign-in failed (${p.authError}). The hub log has the details.`}</p>
					</div>
				)}
				{p.probeError && !p.provider && (
					<div role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
						<p className="font-medium text-danger">Cannot reach the hub</p>
						<p className="mt-1 text-fg-muted">{p.probeError.message}. Is the hub running on the ship network, and is this the right address?</p>
						<button type="button" className="btn btn-sm mt-2" onClick={p.onRetry}>
							Retry
						</button>
					</div>
				)}
				<div className="card">
					<div className="card-body space-y-3">
						{oidc ? (
							<a className="btn btn-primary btn-lg w-full" href={`${AUTH_LOGIN_URL}?returnTo=${encodeURIComponent(location.pathname)}`}>
								Sign in with Maranics
							</a>
						) : (
							<p className="text-sm text-fg-muted">{p.provider?.reason ?? "Sign-in is not configured on this hub."}</p>
						)}
						{oidc && p.provider?.issuerHost && <p className="help text-center">via {p.provider.issuerHost}</p>}
						{dev && (
							<button type="button" className="btn w-full" disabled={busy} onClick={() => void devLogin()}>
								Sign in as {p.provider?.devUserName} (dev)
							</button>
						)}
						{err && <p className="text-sm text-danger">{err}</p>}
					</div>
				</div>
				<p className="mt-4 text-center text-xs text-fg-faint">
					Nothing is spoken and nothing is written before a user is identified. ·{" "}
					<button type="button" className="underline" onClick={() => navigate({ page: "enroll" })}>
						Enroll this device
					</button>
					{p.hubUrl && (
						<>
							{" · "}
							<button type="button" className="underline" onClick={() => setShowQr((v) => !v)}>
								{showQr ? "Hide QR" : "Pair the Android app"}
							</button>
						</>
					)}
					{` · ${versionLine(p.hubVersion)}`}
				</p>
				{showQr && p.hubUrl && <HubQr hubUrl={p.hubUrl} />}
			</div>
		</main>
	);
}

/** The hub address as a QR code (rendered by the hub at /api/qr.svg). Scan it with "Scan QR" in the Android app. */
export function HubQr(p: { hubUrl: string; compact?: boolean }) {
	return (
		<div className={`flex flex-col items-center gap-2 ${p.compact ? "" : "card mt-4 p-4"}`}>
			<img src="/api/qr.svg" width={176} height={176} alt={`QR code for ${p.hubUrl}`} className="rounded bg-white p-1" />
			<code className="break-all text-center text-xs text-fg-muted">{p.hubUrl}</code>
			<p className="text-center text-xs text-fg-faint">Flow Voice Android app → Hub address → Scan QR</p>
		</div>
	);
}
