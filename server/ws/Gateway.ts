/**
 * WebSocket gateway on the hub's single port:
 *   /v1/audio   Audio Endpoint Protocol — one active audio endpoint per station, observers alongside
 *   /v1/events  Event stream for UIs and integrations
 * Implements `EngineIo` for the RunEngine. Audio is transient: PCM chunks are held in memory only
 * between listen.open and listen.close and discarded once transcribed (spec 15).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Logger } from "../core/log.js";
import { parseEndpointMessage, PROTOCOL_VERSION, WS_CLOSE_PROTOCOL, WS_CLOSE_REPLACED, WS_CLOSE_UNAUTHORIZED, type EndpointCapabilities, type ExchangeState, type HubEvent, type HubToEndpointMessage, type RunView } from "../protocol.js";
import type { SttAdapter } from "../speech/stt.js";
import type { HubSession } from "../store/HubStore.js";
import type { EngineIo, RunEngine } from "../voice/RunEngine.js";

export interface GatewayDeps {
	log: Logger;
	hubVersion: string;
	stt: SttAdapter;
	/** Resolve the browser / device session from the upgrade request (cookie or bearer device token). */
	authenticate(req: IncomingMessage): Promise<{ session?: HubSession; deviceId?: string } | undefined>;
	onEndpointChange(stationId: string, endpointId: string | undefined): void;
	/** Persist "this session is on this station". */
	bindStation(session: HubSession, stationId: string, deviceId?: string): Promise<void>;
	now(): number;
}

interface Endpoint {
	ws: WebSocket;
	endpointId: string;
	stationId: string;
	caps: EndpointCapabilities;
	session?: HubSession;
	deviceId?: string;
	language?: string;
	role: "endpoint" | "observer";
	listening?: { promptId: string; chunks: Buffer[]; bytes: number; language?: string; bias?: string[] };
	/** Resolve of the speak() promise waiting for `spoken`. */
	speakWaiter?: { promptId: string; resolve: () => void; timer: NodeJS.Timeout };
	lastSeen: number;
}

const MAX_AUDIO_BYTES = 16000 * 2 * 30; // 30 s of 16 kHz PCM16

export class Gateway implements EngineIo {
	private readonly audioWss = new WebSocketServer({ noServer: true });
	private readonly eventsWss = new WebSocketServer({ noServer: true });
	private readonly endpoints = new Map<string, Endpoint>(); // stationId → active endpoint
	private readonly observers = new Set<Endpoint>();
	private readonly eventClients = new Set<WebSocket>();
	private engine!: RunEngine;
	private sweep: NodeJS.Timeout | undefined;

	constructor(private readonly deps: GatewayDeps) {
		this.audioWss.on("connection", (ws: WebSocket, req: IncomingMessage, ctx: unknown) => this.onAudio(ws, req, ctx as { session?: HubSession; deviceId?: string }));
		this.eventsWss.on("connection", (ws) => this.onEvents(ws));
	}

	attachEngine(engine: RunEngine): void {
		this.engine = engine;
	}

	start(): void {
		this.sweep = setInterval(() => {
			const now = this.deps.now();
			for (const [stationId, ep] of this.endpoints) {
				if (now - ep.lastSeen > 60_000) {
					this.deps.log.warn(`endpoint ${ep.endpointId} on ${stationId} silent for 60 s; dropping`);
					ep.ws.close(WS_CLOSE_PROTOCOL, "silent");
				}
			}
		}, 15_000);
		this.sweep.unref?.();
	}

	stop(): void {
		if (this.sweep) clearInterval(this.sweep);
		for (const ep of this.endpoints.values()) ep.ws.close(1001, "hub stopping");
		for (const ws of this.eventClients) ws.close(1001, "hub stopping");
	}

	/** Route an HTTP upgrade to the right WebSocket server. */
	async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
		const url = new URL(req.url ?? "/", "http://hub");
		if (url.pathname !== "/v1/audio" && url.pathname !== "/v1/events") return false;
		const auth = await this.deps.authenticate(req);
		if (!auth) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return true;
		}
		const wss = url.pathname === "/v1/audio" ? this.audioWss : this.eventsWss;
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, auth));
		return true;
	}

	// ------------------------------------------------------------ endpoints

	private send(ep: Endpoint, m: HubToEndpointMessage): void {
		if (ep.ws.readyState === ep.ws.OPEN) ep.ws.send(JSON.stringify(m));
	}

	private onAudio(ws: WebSocket, req: IncomingMessage, auth: { session?: HubSession; deviceId?: string }): void {
		let ep: Endpoint | undefined;
		const ip = req.socket.remoteAddress ?? "?";
		const hello = setTimeout(() => {
			if (!ep) ws.close(WS_CLOSE_PROTOCOL, "hello expected");
		}, 10_000);
		ws.on("message", (data, isBinary) => {
			if (isBinary) {
				if (ep?.listening && ep.role === "endpoint") {
					const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
					if (ep.listening.bytes + buf.length <= MAX_AUDIO_BYTES) {
						ep.listening.chunks.push(buf);
						ep.listening.bytes += buf.length;
					}
				}
				return;
			}
			const m = parseEndpointMessage(data.toString());
			if (!m) {
				ws.close(WS_CLOSE_PROTOCOL, "bad frame");
				return;
			}
			if (m.type === "hello") {
				clearTimeout(hello);
				ep = { ws, endpointId: m.endpointId, stationId: m.stationId, caps: m.capabilities, session: auth.session, deviceId: auth.deviceId, language: m.language, role: m.observer ? "observer" : "endpoint", lastSeen: this.deps.now() };
				void this.register(ep, ip);
				return;
			}
			if (!ep) {
				ws.close(WS_CLOSE_PROTOCOL, "hello first");
				return;
			}
			ep.lastSeen = this.deps.now();
			void this.onFrame(ep, m);
		});
		ws.on("close", () => {
			clearTimeout(hello);
			if (ep) this.unregister(ep);
		});
		ws.on("error", (err) => this.deps.log.debug(`audio ws error: ${err.message}`));
	}

	private async register(ep: Endpoint, ip: string): Promise<void> {
		if (ep.role === "endpoint") {
			const prev = this.endpoints.get(ep.stationId);
			if (prev && prev !== ep) {
				// same device reconnecting takes over silently; another device must ask (takeover frame)
				if (prev.endpointId === ep.endpointId || prev.ws.readyState !== prev.ws.OPEN) {
					prev.ws.close(WS_CLOSE_REPLACED, "replaced");
				} else {
					ep.role = "observer";
					this.deps.log.info(`${ep.endpointId} joins ${ep.stationId} as observer (${prev.endpointId} holds the microphone)`);
				}
			}
		}
		if (ep.role === "endpoint") {
			this.endpoints.set(ep.stationId, ep);
			this.deps.log.info(`endpoint ${ep.endpointId} active on ${ep.stationId} from ${ip}${ep.session ? ` as ${ep.session.sub}` : " (no user)"}`);
			this.deps.onEndpointChange(ep.stationId, ep.endpointId);
		} else this.observers.add(ep);
		if (ep.session) await this.deps.bindStation(ep.session, ep.stationId, ep.deviceId);
		const run = this.engine.activeRun(ep.stationId);
		this.send(ep, { type: "hello", protocol: PROTOCOL_VERSION, hubVersion: this.deps.hubVersion, stationId: ep.stationId, role: ep.role, runId: run?.runId });
		this.send(ep, { type: "run", run: run ? this.engine.toView(run) : null });
		this.emit({ type: "station.endpoint", at: new Date(this.deps.now()).toISOString(), stationId: ep.stationId, text: ep.role === "endpoint" ? `${ep.endpointId} active` : `${ep.endpointId} observing` });
		if (ep.role === "endpoint") await this.engine.onEndpointReady(ep.stationId, ep.session);
	}

	private unregister(ep: Endpoint): void {
		this.observers.delete(ep);
		if (this.endpoints.get(ep.stationId) === ep) {
			this.endpoints.delete(ep.stationId);
			if (ep.speakWaiter) {
				clearTimeout(ep.speakWaiter.timer);
				ep.speakWaiter.resolve();
			}
			this.deps.log.info(`endpoint ${ep.endpointId} left ${ep.stationId}`);
			this.deps.onEndpointChange(ep.stationId, undefined);
			this.emit({ type: "station.endpoint", at: new Date(this.deps.now()).toISOString(), stationId: ep.stationId, text: `${ep.endpointId} left` });
			void this.engine.onEndpointLost(ep.stationId);
			// promote an observer with the same station (first come)
			const next = [...this.observers].find((o) => o.stationId === ep.stationId && o.ws.readyState === o.ws.OPEN);
			if (next) {
				this.observers.delete(next);
				next.role = "endpoint";
				this.endpoints.set(next.stationId, next);
				this.send(next, { type: "hello", protocol: PROTOCOL_VERSION, hubVersion: this.deps.hubVersion, stationId: next.stationId, role: "endpoint" });
				this.deps.onEndpointChange(next.stationId, next.endpointId);
				void this.engine.onEndpointReady(next.stationId);
			}
		}
	}

	private async onFrame(ep: Endpoint, m: Exclude<ReturnType<typeof parseEndpointMessage>, undefined>): Promise<void> {
		switch (m.type) {
			case "ping":
				this.send(ep, { type: "pong" });
				return;
			case "takeover": {
				const prev = this.endpoints.get(ep.stationId);
				if (prev && prev !== ep) {
					this.send(prev, { type: "released", by: ep.endpointId });
					prev.role = "observer";
					this.observers.add(prev);
					this.deps.log.info(`${ep.endpointId} took over ${ep.stationId} from ${prev.endpointId}`);
				}
				this.observers.delete(ep);
				ep.role = "endpoint";
				this.endpoints.set(ep.stationId, ep);
				this.send(ep, { type: "hello", protocol: PROTOCOL_VERSION, hubVersion: this.deps.hubVersion, stationId: ep.stationId, role: "endpoint" });
				this.deps.onEndpointChange(ep.stationId, ep.endpointId);
				await this.engine.onEndpointReady(ep.stationId, ep.session);
				return;
			}
			case "spoken":
				if (ep.speakWaiter && (!m.promptId || ep.speakWaiter.promptId === m.promptId)) {
					clearTimeout(ep.speakWaiter.timer);
					ep.speakWaiter.resolve();
					ep.speakWaiter = undefined;
				}
				return;
			case "ptt":
				if (ep.role !== "endpoint") return;
				if (m.state === "up" && ep.listening) await this.closeCapture(ep, "ptt");
				return;
			case "audio.end":
				if (ep.role !== "endpoint") return;
				await this.closeCapture(ep, m.reason);
				return;
			case "transcript":
				if (ep.role !== "endpoint") return;
				if (!m.final) {
					this.engine.onPartial(ep.stationId, m.text);
					return;
				}
				if (ep.listening) {
					ep.listening = undefined;
					this.send(ep, { type: "listen.close" });
				}
				await this.engine.onTranscript(ep.stationId, m.text, m.confidence, ep.session);
				return;
			case "command":
				if (ep.role !== "endpoint") return;
				await this.engine.onTranscript(ep.stationId, m.name, 1, ep.session);
				return;
			default:
				return;
		}
	}

	private async closeCapture(ep: Endpoint, reason: string): Promise<void> {
		const l = ep.listening;
		if (!l) return;
		ep.listening = undefined;
		this.send(ep, { type: "listen.close" });
		if (reason === "cancel") return;
		if (this.deps.stt.kind === "http" && l.bytes > 3200) {
			const pcm = Buffer.concat(l.chunks);
			l.chunks.length = 0;
			try {
				const r = await this.deps.stt.transcribe(pcm, { language: l.language, bias: l.bias });
				await this.engine.onTranscript(ep.stationId, r.text, r.confidence, ep.session);
			} catch (err) {
				this.deps.log.warn(`stt failed: ${err instanceof Error ? err.message : String(err)}`);
				this.engine.onListenEnd(ep.stationId);
			}
			return;
		}
		this.engine.onListenEnd(ep.stationId);
	}

	// ------------------------------------------------------------ EngineIo

	speak(stationId: string, promptId: string, text: string, language: string): Promise<void> {
		const ep = this.endpoints.get(stationId);
		const msg: HubToEndpointMessage = { type: "speak", promptId, text, language, bargeIn: !!ep?.caps.aec, audioFormat: ep?.caps.localTts === false ? "wav" : "none" };
		for (const o of this.observers) if (o.stationId === stationId) this.send(o, { type: "status", state: "speaking", text });
		if (!ep) {
			this.deps.log.debug(`speak on ${stationId} (no endpoint): ${text}`);
			return Promise.resolve();
		}
		if (ep.speakWaiter) {
			clearTimeout(ep.speakWaiter.timer);
			ep.speakWaiter.resolve();
		}
		this.send(ep, msg);
		const fallbackMs = Math.min(20_000, 1200 + text.length * 70);
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (ep.speakWaiter?.promptId === promptId) ep.speakWaiter = undefined;
				resolve();
			}, fallbackMs);
			timer.unref?.();
			ep.speakWaiter = { promptId, resolve, timer };
		});
	}

	listen(stationId: string, promptId: string, opts: { maxMs: number; bias?: string[]; expect?: string; grammar?: string[] }): void {
		const ep = this.endpoints.get(stationId);
		if (!ep) return;
		ep.listening = { promptId, chunks: [], bytes: 0, language: ep.language, bias: opts.bias };
		this.send(ep, { type: "listen.open", promptId, maxMs: opts.maxMs, vad: !ep.caps.pushToTalk, bias: opts.bias, expect: opts.expect, grammar: opts.grammar });
	}

	stopListening(stationId: string): void {
		const ep = this.endpoints.get(stationId);
		if (!ep) return;
		if (ep.listening) {
			ep.listening = undefined;
			this.send(ep, { type: "listen.close" });
		}
	}

	status(stationId: string, state: ExchangeState, text?: string): void {
		const m: HubToEndpointMessage = { type: "status", state, text };
		const ep = this.endpoints.get(stationId);
		if (ep) this.send(ep, m);
		for (const o of this.observers) if (o.stationId === stationId) this.send(o, m);
	}

	navigate(stationId: string, page: "picker" | "run", opts: { runId?: string; stationId?: string } = {}): void {
		const m: HubToEndpointMessage = { type: "navigate", page, runId: opts.runId, stationId: opts.stationId };
		const ep = this.endpoints.get(stationId);
		if (ep) this.send(ep, m);
		for (const o of this.observers) if (o.stationId === stationId) this.send(o, m);
	}

	/** Language the active endpoint asked for in `hello` (the phone's picker), if any. */
	endpointLanguage(stationId: string): string | undefined {
		const ep = this.endpoints.get(stationId);
		return ep && ep.ws.readyState === ep.ws.OPEN && ep.language ? ep.language : undefined;
	}

	hasEndpoint(stationId: string): boolean {
		const ep = this.endpoints.get(stationId);
		return !!ep && ep.ws.readyState === ep.ws.OPEN;
	}

	pushRun(stationId: string, run: RunView | null): void {
		const m: HubToEndpointMessage = { type: "run", run };
		const ep = this.endpoints.get(stationId);
		if (ep) this.send(ep, m);
		for (const o of this.observers) if (o.stationId === stationId) this.send(o, m);
		for (const ws of this.eventClients) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
	}

	emit(event: HubEvent): void {
		const text = JSON.stringify({ type: "event", event } satisfies HubToEndpointMessage);
		for (const ws of this.eventClients) if (ws.readyState === ws.OPEN) ws.send(text);
		for (const o of this.observers) if (!event.stationId || o.stationId === event.stationId) this.send(o, { type: "event", event });
		const ep = event.stationId ? this.endpoints.get(event.stationId) : undefined;
		if (ep) this.send(ep, { type: "event", event });
	}

	stations(): { stationId: string; endpointId: string; user?: string; caps: EndpointCapabilities; observers: number }[] {
		return [...this.endpoints.values()].map((ep) => ({ stationId: ep.stationId, endpointId: ep.endpointId, user: ep.session?.sub, caps: ep.caps, observers: [...this.observers].filter((o) => o.stationId === ep.stationId).length }));
	}

	/** Drop every socket of a device (revocation takes effect on the next frame). */
	dropDevice(deviceId: string): void {
		for (const ep of [...this.endpoints.values(), ...this.observers]) if (ep.deviceId === deviceId) ep.ws.close(WS_CLOSE_UNAUTHORIZED, "device revoked");
	}

	dropSession(sessionId: string): void {
		for (const ep of [...this.endpoints.values(), ...this.observers]) if (ep.session?.id === sessionId) ep.ws.close(WS_CLOSE_UNAUTHORIZED, "session ended");
	}

	// ------------------------------------------------------------ events

	private onEvents(ws: WebSocket): void {
		this.eventClients.add(ws);
		ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, hubVersion: this.deps.hubVersion, stationId: "*", role: "observer" } satisfies HubToEndpointMessage));
		for (const r of this.engine.listRuns()) ws.send(JSON.stringify({ type: "run", run: r } satisfies HubToEndpointMessage));
		ws.on("message", (data) => {
			if (data.toString() === '{"type":"ping"}') ws.send('{"type":"pong"}');
		});
		ws.on("close", () => this.eventClients.delete(ws));
		ws.on("error", () => this.eventClients.delete(ws));
	}
}
