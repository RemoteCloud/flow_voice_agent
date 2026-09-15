/**
 * App-wide voice session. One AudioEndpoint per browser tab / Android WebView, alive across the
 * picker and the run screen, so the whole app can be driven by voice once it is on: the hub reads
 * the checklist menu, starts runs, moves the screen (`navigate` frames) and confirms complete /
 * discard by voice. Started automatically on Android and on stations with an open audio policy;
 * elsewhere the first tap is the browser's audio gesture.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RunView } from "../../server/api.js";
import type { HubEvent } from "../../server/protocol.js";
import { AudioEndpoint, type EndpointState } from "./audio.js";
import { useApp } from "./context.js";
import { navigate } from "./router.js";

export interface VoiceApi {
	state: EndpointState;
	stateText?: string;
	role: "endpoint" | "observer";
	stationId?: string;
	handsFree: boolean;
	handsFreeSupported: boolean;
	transcript: string;
	run: RunView | null | undefined;
	events: HubEvent[];
	error?: string;
	active: boolean;
	start(stationId?: string): Promise<void>;
	stop(): void;
	takeover(): void;
	pttStart(): void;
	pttEnd(): void;
	sayText(text: string): void;
	setHandsFree(on: boolean): void;
	clearError(): void;
}

const VoiceContext = createContext<VoiceApi | null>(null);

function endpointId(): string {
	let id = localStorage.getItem("fv.endpointId");
	if (!id) {
		id = `${window.FlowVoiceAndroid ? "android" : "pwa"}-${Math.random().toString(36).slice(2, 8)}`;
		localStorage.setItem("fv.endpointId", id);
	}
	return id;
}

export function VoiceProvider({ children }: { children: ReactNode }) {
	const { me, boot, stations, setStation } = useApp();
	const ep = useRef<AudioEndpoint | undefined>(undefined);
	const wakeLock = useRef<WakeLockSentinel | undefined>(undefined);
	const [state, setState] = useState<EndpointState>("disconnected");
	const [stateText, setStateText] = useState<string | undefined>();
	const [role, setRole] = useState<"endpoint" | "observer">("observer");
	const [stationId, setStationId] = useState<string | undefined>();
	const [transcript, setTranscript] = useState("");
	const [run, setRun] = useState<RunView | null | undefined>(undefined);
	const [events, setEvents] = useState<HubEvent[]>([]);
	const [error, setError] = useState<string | undefined>();
	const [handsFree, setHandsFreeState] = useState<boolean>(() => {
		const saved = localStorage.getItem("fv.handsFree");
		return saved !== null ? saved === "1" : !!window.FlowVoiceAndroid;
	});
	const pendingStation = useRef<string | undefined>(undefined);

	const stop = useCallback(() => {
		ep.current?.stop();
		ep.current = undefined;
		void wakeLock.current?.release();
		wakeLock.current = undefined;
		setState("disconnected");
		setRole("observer");
		setStationId(undefined);
	}, []);

	const start = useCallback(
		async (wanted?: string) => {
			const sid = wanted ?? me.stationId;
			if (!sid) {
				setError("Pick a station first.");
				return;
			}
			if (ep.current && stationId === sid) return;
			if (ep.current) stop();
			const station = stations.find((s) => s.stationId === sid);
			const open = station?.audioPolicy === "open";
			setError(undefined);
			const endpoint = new AudioEndpoint(
				{ stationId: sid, endpointId: endpointId(), language: station?.language ?? "en", sttOnEndpoint: boot.speech.stt === "endpoint", pushToTalk: !open, handsFree: handsFree || open },
				{
					onState: (s, t) => {
						setState(s);
						setStateText(t);
					},
					onRun: (r) => setRun(r),
					onEvent: (e) => setEvents((prev) => [e, ...prev].slice(0, 30)),
					onTranscript: (t, final) => setTranscript(final ? "" : t),
					onError: (m) => setError(m),
					onRole: setRole,
					onNavigate: (page, opts) => {
						if (opts.stationId && opts.stationId !== sid) {
							// the hub moved us to another station: rebind the session and reconnect there
							pendingStation.current = opts.stationId;
							void setStation(opts.stationId);
							navigate({ page: "picker" });
							return;
						}
						if (page === "run" && opts.runId) navigate({ page: "run", id: opts.runId });
						else navigate({ page: "picker" });
					},
				},
			);
			ep.current = endpoint;
			setStationId(sid);
			try {
				await endpoint.start();
				if ("wakeLock" in navigator) wakeLock.current = await navigator.wakeLock.request("screen").catch(() => undefined);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
				endpoint.stop();
				ep.current = undefined;
				setStationId(undefined);
			}
		},
		[me.stationId, stationId, stations, boot.speech.stt, handsFree, stop, setStation],
	);

	// station switched by voice: reconnect once the session carries the new station
	useEffect(() => {
		if (pendingStation.current && me.stationId === pendingStation.current) {
			const s = pendingStation.current;
			pendingStation.current = undefined;
			void start(s);
		}
	}, [me.stationId, start]);

	// Android and open-policy stations start voice by themselves once a station is chosen
	useEffect(() => {
		if (ep.current || !me.stationId) return;
		const st = stations.find((s) => s.stationId === me.stationId);
		if (window.FlowVoiceAndroid || st?.audioPolicy === "open") void start(me.stationId);
	}, [me.stationId, stations, start]);

	useEffect(() => () => stop(), [stop]);

	// keyboard push-to-talk anywhere in the app: hold Space outside text fields
	useEffect(() => {
		const down = (e: KeyboardEvent) => {
			const tag = document.activeElement?.tagName;
			if (e.code === "Space" && !e.repeat && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
				e.preventDefault();
				ep.current?.pttStart();
			}
		};
		const up = (e: KeyboardEvent) => {
			if (e.code === "Space") ep.current?.pttEnd();
		};
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		return () => {
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
		};
	}, []);

	const api = useMemo<VoiceApi>(
		() => ({
			state,
			stateText,
			role,
			stationId,
			handsFree,
			handsFreeSupported: ep.current ? ep.current.handsFreeSupported : boot.speech.stt === "endpoint",
			transcript,
			run,
			events,
			error,
			active: state !== "disconnected",
			start,
			stop,
			takeover: () => ep.current?.takeover(),
			pttStart: () => ep.current?.pttStart(),
			pttEnd: () => ep.current?.pttEnd(),
			sayText: (t) => ep.current?.sayText(t),
			setHandsFree: (on) => {
				setHandsFreeState(on);
				localStorage.setItem("fv.handsFree", on ? "1" : "0");
				ep.current?.setHandsFree(on);
			},
			clearError: () => setError(undefined),
		}),
		[state, stateText, role, stationId, handsFree, transcript, run, events, error, start, stop, boot.speech.stt],
	);

	return <VoiceContext.Provider value={api}>{children}</VoiceContext.Provider>;
}

export function useVoice(): VoiceApi {
	const v = useContext(VoiceContext);
	if (!v) throw new Error("useVoice outside VoiceProvider");
	return v;
}

export const STATE_TEXT: Record<EndpointState, string> = { disconnected: "Voice off", connecting: "Connecting…", observer: "Observing", ready: "Ready", speaking: "Speaking", listening: "Listening", thinking: "…" };

/** The voice status pill + start/stop + hands-free, shared by the picker and the run screen. */
export function VoiceBar({ compact }: { compact?: boolean }) {
	const v = useVoice();
	const { me, stations } = useApp();
	const station = stations.find((s) => s.stationId === (v.stationId ?? me.stationId));
	const listening = v.state === "listening";
	return (
		<div className="flex flex-wrap items-center gap-2">
			<span className={`pill max-w-full ${listening ? "border-danger text-danger" : v.state === "speaking" ? "border-accent text-accent" : v.state === "ready" ? "border-ok/50 text-ok" : "border-line-strong text-fg-muted"}`}>
				<span className="truncate">
					{STATE_TEXT[v.state]}
					{v.stateText ? ` · ${v.stateText}` : ""}
				</span>
			</span>
			{!v.active ? (
				<button type="button" className={`btn btn-primary ${compact ? "btn-sm" : ""}`} onClick={() => void v.start()} disabled={!me.stationId}>
					Start voice{station ? ` on ${station.name}` : ""}
				</button>
			) : (
				<>
					{v.role === "observer" && (
						<button type="button" className="btn btn-sm" onClick={v.takeover}>
							Take over
						</button>
					)}
					<label className="flex items-center gap-1.5 text-xs text-fg-muted">
						<input type="checkbox" checked={v.handsFree} onChange={(e) => v.setHandsFree(e.target.checked)} disabled={!v.handsFreeSupported} />
						Hands-free
					</label>
					<button type="button" className="btn btn-sm btn-ghost" onClick={v.stop}>
						Voice off
					</button>
				</>
			)}
		</div>
	);
}
