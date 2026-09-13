import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MeResponse, SessionProbeResponse, Station } from "../../server/api.js";
import { api, setUnauthorizedHandler, toApiError, type ApiClientError } from "./api.js";
import { Shell } from "./components/Shell.js";
import { AppContext, type AppApi } from "./context.js";
import { AdminPage } from "./pages/Admin.js";
import { EnrollPage } from "./pages/Enroll.js";
import { LoginPage } from "./pages/Login.js";
import { PickerPage } from "./pages/Picker.js";
import { RunPage } from "./pages/Run.js";
import { navigate, useRoute } from "./router.js";
import { VoiceProvider } from "./voice.js";

export function App() {
	const route = useRoute();
	const [boot, setBoot] = useState<SessionProbeResponse | undefined>();
	const [bootError, setBootError] = useState<ApiClientError | undefined>();
	const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
	const [notice, setNotice] = useState<string | undefined>();
	const [authError] = useState(() => new URLSearchParams(location.search).get("auth_error") ?? undefined);
	const probeGen = useRef(0);

	const probe = useCallback(async () => {
		const gen = ++probeGen.current;
		try {
			const res = await api.get<SessionProbeResponse>("auth/session", { noAuthRedirect: true });
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
		void probe();
	}, [probe]);

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

	const ctx = useMemo<AppApi | null>(() => (me && boot ? { me, boot, refreshMe, signOut, setStation, stations: boot.stations as Station[] } : null), [me, boot, refreshMe, signOut, setStation]);

	if (route.page === "enroll") return <EnrollPage />;
	if (me === undefined) return <Splash />;
	if (!ctx) return <LoginPage provider={boot?.provider} hubVersion={boot?.hubVersion} vesselId={boot?.vesselId} authError={authError} notice={notice} probeError={bootError} onRetry={() => void probe()} onDevSignedIn={(m) => setMe(m)} />;

	return (
		<AppContext.Provider value={ctx}>
			<VoiceProvider>
				<Shell route={route}>
					{route.page === "run" && route.id ? <RunPage runId={route.id} /> : route.page === "admin" ? <AdminPage /> : <PickerPage onOpenRun={(id) => navigate({ page: "run", id })} />}
				</Shell>
			</VoiceProvider>
		</AppContext.Provider>
	);
}

function Splash() {
	return (
		<main className="flex min-h-screen items-center justify-center text-fg-muted" aria-busy="true">
			<div className="flex items-center gap-3">
				<img src="/icon.svg" width={28} height={28} alt="" className="motion-safe:animate-pulse" />
				<span>Flow Voice — contacting the hub…</span>
			</div>
		</main>
	);
}
