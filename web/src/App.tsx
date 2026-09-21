import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JoinResponse, MeResponse, SessionProbeResponse, Station } from "../../server/api.js";
import { api, setUnauthorizedHandler, toApiError, type ApiClientError } from "./api.js";
import { Shell } from "./components/Shell.js";
import { AppContext, type AppApi } from "./context.js";
import { AdminPage } from "./pages/Admin.js";
import { EnrollPage } from "./pages/Enroll.js";
import { HomePage } from "./pages/Home.js";
import { LoginPage } from "./pages/Login.js";
import { RunPage } from "./pages/Run.js";
import { isMobileClient } from "./platform.js";
import { navigate, parseRoute, useRoute } from "./router.js";
import { VoiceProvider } from "./voice.js";

/** Station QR: `#/join/<token>` is redeemed once on boot, then scrubbed from the address bar. */
type JoinState = { state: "pending" } | { state: "ok"; station: JoinResponse["station"] } | { state: "invalid"; message: string };

export function App() {
	const mobile = isMobileClient();
	const rawRoute = useRoute();
	// the mobile client has no Admin: it runs checklists and drives voice, nothing else
	const route = mobile && rawRoute.page === "admin" ? ({ page: "picker" } as const) : rawRoute;
	const [boot, setBoot] = useState<SessionProbeResponse | undefined>();
	const [bootError, setBootError] = useState<ApiClientError | undefined>();
	const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
	const [notice, setNotice] = useState<string | undefined>();
	const [authError] = useState(() => new URLSearchParams(location.search).get("auth_error") ?? undefined);
	const [joinToken] = useState(() => {
		const r = parseRoute(location.hash);
		return r.page === "join" ? r.token : undefined;
	});
	const [join, setJoin] = useState<JoinState | undefined>(() => (joinToken ? { state: "pending" } : undefined));
	const probeGen = useRef(0);

	const probe = useCallback(async () => {
		const gen = ++probeGen.current;
		try {
			const res = await api.get<SessionProbeResponse>("auth/session", {
				noAuthRedirect: true,
			});
			if (gen !== probeGen.current) return;
			setBoot(res);
			setBootError(undefined);
			setMe(res.authenticated && res.me ? res.me : null);
		} catch (e) {
			if (gen !== probeGen.current) return;
			setBootError(toApiError(e));
			setMe(null);
		}
	}, []);

	useEffect(() => {
		const url = new URL(location.href);
		if (url.searchParams.has("auth_error")) {
			url.searchParams.delete("auth_error");
			history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
		}
		if (!joinToken) {
			void probe();
			return;
		}
		// The token must not linger in the address bar or history; `?mobile=1` has already been remembered by isMobileClient().
		history.replaceState(history.state, "", location.pathname);
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		void (async () => {
			try {
				const res = await api.post<JoinResponse>("auth/join", { token: joinToken }, { noAuthRedirect: true });
				setJoin({ state: "ok", station: res.station });
			} catch (e) {
				const a = toApiError(e);
				setJoin({ state: "invalid", message: a.code === "JOIN_INVALID" ? "This QR code is no longer valid." : a.code === "RATE_LIMITED" ? "Too many scans from this network right now. Try again in a few minutes." : `The station could not be joined (${a.message}).` });
			}
			await probe();
		})();
	}, [probe, joinToken]);

	const sessionLost = useCallback(
		(text?: string) => {
			setNotice(text ?? "Your session has ended. Sign in again.");
			setMe(null);
			void probe();
		},
		[probe],
	);
	useEffect(() => {
		setUnauthorizedHandler(() => sessionLost());
		return () => setUnauthorizedHandler(undefined);
	}, [sessionLost]);

	const refreshMe = useCallback(async () => {
		try {
			setMe(await api.get<MeResponse>("auth/me"));
		} catch {
			/* 401 already handled */
		}
	}, []);

	const setStation = useCallback(async (stationId: string) => {
		setMe(await api.put<MeResponse>("auth/station", { stationId }));
	}, []);

	const signOut = useCallback(async () => {
		let next = "/";
		try {
			const res = await api.post<{ endSessionUrl: string }>("auth/logout", {}, { noAuthRedirect: true });
			if (res.endSessionUrl) next = res.endSessionUrl;
		} catch {
			/* reload re-probes */
		}
		location.replace(next);
	}, []);

	const ctx = useMemo<AppApi | null>(
		() =>
			me && boot
				? {
						me,
						boot,
						refreshMe,
						signOut,
						setStation,
						stations: boot.stations as Station[],
					}
				: null,
		[me, boot, refreshMe, signOut, setStation],
	);

	if (route.page === "enroll") return <EnrollPage />;
	if (join?.state === "pending") return <Splash text="Joining the station…" />;
	if (me === undefined) return <Splash />;
	if (!ctx)
		return (
			<LoginPage
				provider={boot?.provider}
				hubVersion={boot?.hubVersion}
				vesselId={boot?.vesselId}
				hubUrl={boot?.hubUrl}
				authError={authError}
				notice={notice}
				probeError={bootError}
				joinStation={join?.state === "ok" ? join.station : undefined}
				joinError={join?.state === "invalid" ? join.message : undefined}
				onRetry={() => void probe()}
				onDevSignedIn={(m) => setMe(m)}
			/>
		);

	return (
		<AppContext.Provider value={ctx}>
			<VoiceProvider>
				<Shell route={route} mobile={mobile}>
					{route.page === "run" && route.id ? <RunPage runId={route.id} mobile={mobile} /> : route.page === "admin" && !mobile ? <AdminPage /> : <HomePage mobile={mobile} onOpenRun={(id) => navigate({ page: "run", id })} />}
				</Shell>
			</VoiceProvider>
		</AppContext.Provider>
	);
}

function Splash({ text = "Flow Voice — contacting the hub…" }: { text?: string }) {
	return (
		<main className="flex min-h-screen items-center justify-center text-fg-muted" aria-busy="true">
			<div className="flex items-center gap-3">
				<img src="/icon.svg" width={28} height={28} alt="" className="motion-safe:animate-pulse" />
				<span>{text}</span>
			</div>
		</main>
	);
}
