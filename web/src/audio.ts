/**
 * Audio endpoint (AEP client) for the browser and the Android WebView.
 *
 *   - TTS: the Web Speech API (`speechSynthesis`), or the Android bridge (`window.FlowVoiceAndroid`).
 *   - STT: the Web Speech API (`SpeechRecognition`) when the hub says STT runs on the endpoint;
 *     otherwise the microphone is captured with an AudioWorklet, downsampled to 16 kHz PCM16 and
 *     streamed as binary frames only while a listen window is open.
 *   - Push-to-talk: the big button, a bound media key, or the Android hardware button.
 *
 * Browsers need a user gesture before audio; `start()` must be called from a tap.
 */
import type { EndpointCapabilities, EndpointMessage, HubEvent, HubToEndpointMessage, RunView } from "../../server/protocol.js";
import { wsUrl } from "./api.js";

declare global {
	interface Window {
		FlowVoiceAndroid?: {
			speak(text: string, language: string, promptId: string): void;
			stopSpeaking(): void;
			startListening(language: string, maxMs: number, promptId: string): void;
			/** Newer app builds: recognise `language` and also switch to `extraLanguage` (comma-separated tags) when the speaker uses it. */
			startListeningIn?(language: string, extraLanguages: string, maxMs: number, promptId: string): void;
			/** Newest app builds: like startListeningIn plus bias words (comma-separated) the recogniser should favour. */
			startListeningWith?(language: string, extraLanguages: string, bias: string, maxMs: number, promptId: string): void;
			/** Grammar-restricted offline recogniser (Vosk): is a model for this language ready on the phone? */
			hasGrammarStt?(language: string): boolean;
			/** Load / download the model for this language in the background (call when the answer language changes). */
			prepareGrammarStt?(language: string): void;
			/** Listen for the given phrases only (JSON array); anything else comes back as silence. */
			startListeningGrammar?(language: string, grammarJson: string, maxMs: number, promptId: string): void;
			stopListening(): void;
			setForeground(active: boolean, text: string): void;
			hasLocalStt(): boolean;
			version(): string;
			setTheme?(theme: "light" | "dark"): void;
		};
		flowVoiceBridge?: {
			onSpoken(promptId: string): void;
			onTranscript(text: string, confidence: number, final: boolean): void;
			onListenEnd(reason: string): void;
			onPtt(down: boolean): void;
		};
		webkitSpeechRecognition?: typeof SpeechRecognition;
		webkitAudioContext?: typeof AudioContext;
	}
}

export type EndpointState = "disconnected" | "connecting" | "observer" | "ready" | "speaking" | "listening" | "thinking";

export interface EndpointCallbacks {
	onState(state: EndpointState, text?: string): void;
	onRun(run: RunView | null): void;
	onEvent(event: HubEvent): void;
	onTranscript(text: string, final: boolean): void;
	onError(message: string): void;
	onRole(role: "endpoint" | "observer"): void;
	onNavigate?(page: "picker" | "run", opts: { runId?: string; stationId?: string }): void;
}

export interface EndpointOptions {
	stationId: string;
	endpointId: string;
	language: string;
	/** Language the crew answers in ("" = same as `language`). The checklist is spoken in `language`; answers may be in this one. */
	answerLanguage?: string;
	/** Hub says STT is on the endpoint → use SpeechRecognition; else stream PCM. */
	sttOnEndpoint: boolean;
	pushToTalk: boolean;
	observer?: boolean;
	/** Open-mic loop between prompts: spoken commands and unprompted answers work without touching the screen. */
	handsFree?: boolean;
	/** Noisy bridge: the mic opens only while push-to-talk is held, never on its own after a prompt. */
	holdToAnswer?: boolean;
}

const IDLE = "idle";
const IDLE_WINDOW_MS = 45000;
const ECHO_GUARD_MS = 2500;

const hasAndroid = () => typeof window !== "undefined" && !!window.FlowVoiceAndroid;

export class AudioEndpoint {
	private ws: WebSocket | undefined;
	private closed = false;
	private retry = 0;
	private recognition: SpeechRecognition | undefined;
	private audioCtx: AudioContext | undefined;
	private worklet: AudioWorkletNode | undefined;
	private stream: MediaStream | undefined;
	private listenPromptId: string | undefined;
	private listenTimer: number | undefined;
	private pingTimer: number | undefined;
	private role: "endpoint" | "observer" = "observer";
	private lastFinal = "";
	private pttDown = false;
	private handsFree = false;
	private idleTimer: number | undefined;
	private speakingNow = false;
	private speakSeq = 0;
	/** Android: the utterance in flight; resolved by flowVoiceBridge.onSpoken (or a safety timeout). */
	private pendingSpoken: { promptId: string; finish: () => void } | undefined;
	private lastSpokenText = "";
	private lastSpokenAt = 0;
	readonly capabilities: EndpointCapabilities;

	constructor(
		private readonly opts: EndpointOptions,
		private readonly cb: EndpointCallbacks,
	) {
		const localStt = opts.sttOnEndpoint && (hasAndroid() ? window.FlowVoiceAndroid!.hasLocalStt() : !!(window.SpeechRecognition ?? window.webkitSpeechRecognition));
		this.handsFree = !!opts.handsFree;
		this.capabilities = { input: [hasAndroid() ? "android-mic" : "browser-mic"], sampleRate: 16000, aec: false, pushToTalk: opts.pushToTalk && !this.handsFree, wakeWord: false, localTts: true, localStt };
		window.FlowVoiceAndroid?.prepareGrammarStt?.(opts.answerLanguage || opts.language);
		window.flowVoiceBridge = {
			onSpoken: (promptId) => {
				const p = this.pendingSpoken;
				if (p && (!promptId || p.promptId === promptId)) p.finish();
				else this.send({ type: "spoken", promptId });
			},
			onTranscript: (text, confidence, final) => this.deliverTranscript(text, confidence, final),
			onListenEnd: (reason) => {
				// "error:<name>" comes from the Android recogniser (language pack missing, audio, server …): say so
				// instead of letting it pass as silence — the hub would just retry and move on
				if (reason.startsWith("error:")) {
					this.cb.onError(`Speech recognition failed on this phone: ${reason.slice(6)} (language ${this.opts.language || "default"}). Check the phone's speech language pack or pick another voice language.`);
					this.endListen("timeout");
					return;
				}
				this.endListen(reason as "silence" | "ptt" | "timeout" | "cancel");
			},
			onPtt: (down) => (down ? this.pttStart() : this.pttEnd()),
		};
	}

	get currentRole(): "endpoint" | "observer" {
		return this.role;
	}

	get isHandsFree(): boolean {
		return this.handsFree;
	}

	/** Hands-free needs on-device recognition (the hub only accepts streamed audio inside a listen window). */
	get handsFreeSupported(): boolean {
		return !!this.capabilities.localStt;
	}

	/** Change the language the recogniser listens for; takes effect at the next listen window. */
	setAnswerLanguage(lang: string): void {
		this.opts.answerLanguage = lang;
		window.FlowVoiceAndroid?.prepareGrammarStt?.(lang || this.opts.language);
	}

	/** Hold-to-answer: a prompt arms the window, the mic opens only while push-to-talk is held. */
	setHoldToAnswer(on: boolean): void {
		this.opts.holdToAnswer = on;
		if (!on && this.armed) this.startArmed();
	}

	get isHoldToAnswer(): boolean {
		return !!this.opts.holdToAnswer;
	}

	/** A prompt window the hub opened that waits for push-to-talk (hold-to-answer). */
	private armed: { maxMs: number } | undefined;
	/** Bias words of the current window, forwarded to the phone's recogniser. */
	private bias: string[] = [];
	/** Allowed vocabulary of the current window (hub grammar); with a Vosk model on the phone, nothing else is heard. */
	private grammar: string[] | undefined;

	private startArmed(): void {
		const a = this.armed;
		if (!a || !this.listenPromptId) return;
		this.armed = undefined;
		this.cb.onState("listening");
		if (this.capabilities.localStt) this.startRecognition(a.maxMs);
		else void this.startStreaming(a.maxMs);
	}

	setHandsFree(on: boolean): void {
		this.handsFree = on && this.handsFreeSupported;
		if (this.handsFree) this.scheduleIdle(200);
		else if (this.listenPromptId === IDLE) this.stopListen("cancel");
		if (!this.handsFree) this.clearIdleTimer();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) window.clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	/** (Re)open the idle listening window unless a prompt window or TTS is active. */
	private scheduleIdle(delayMs: number): void {
		this.clearIdleTimer();
		if (!this.handsFree || !this.handsFreeSupported) return;
		this.idleTimer = window.setTimeout(() => {
			this.idleTimer = undefined;
			if (!this.handsFree || this.role !== "endpoint" || this.speakingNow || this.listenPromptId || this.closed) return;
			this.listenPromptId = IDLE;
			this.lastFinal = "";
			this.cb.onState("ready", "hands-free");
			this.startRecognition(IDLE_WINDOW_MS);
		}, delayMs);
	}

	/** Must be called from a user gesture (audio unlock). */
	async start(): Promise<void> {
		this.closed = false;
		if (!hasAndroid() && !this.capabilities.localStt) await this.ensureMic();
		if (!hasAndroid() && "speechSynthesis" in window) {
			// warm up: iOS only speaks after a gesture-triggered utterance
			const u = new SpeechSynthesisUtterance("");
			window.speechSynthesis.speak(u);
		}
		this.connect();
	}

	stop(): void {
		this.closed = true;
		this.clearIdleTimer();
		this.stopListen("cancel");
		this.ws?.close(1000, "endpoint stopped");
		this.ws = undefined;
		if (this.pingTimer) window.clearInterval(this.pingTimer);
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = undefined;
		void this.audioCtx?.close();
		this.audioCtx = undefined;
		if (hasAndroid()) window.FlowVoiceAndroid!.setForeground(false, "");
		this.cb.onState("disconnected");
	}

	takeover(): void {
		this.send({ type: "takeover" });
	}

	command(name: string): void {
		this.send({ type: "command", name });
	}

	/** Send text as if it were spoken (typing an answer, or a test harness). */
	sayText(text: string): void {
		this.send({ type: "transcript", text, confidence: 1, final: true });
	}

	pttStart(): void {
		if (this.role !== "endpoint" || this.pttDown) return;
		this.pttDown = true;
		this.send({ type: "ptt", state: "down" });
		// an armed prompt window (hold-to-answer) opens now; otherwise PTT opens the mic even if the hub has not asked yet
		if (this.armed) this.startArmed();
		else if (!this.listenPromptId || this.listenPromptId === IDLE) this.openListen("ptt", 15000);
	}

	pttEnd(): void {
		if (!this.pttDown) return;
		this.pttDown = false;
		this.send({ type: "ptt", state: "up" });
		if (this.capabilities.localStt) this.stopRecognition();
		else this.endListen("ptt");
	}

	// ------------------------------------------------------------ socket

	private connect(): void {
		if (this.closed) return;
		this.cb.onState("connecting");
		const ws = new WebSocket(wsUrl("/v1/audio"));
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.onopen = () => {
			this.retry = 0;
			this.send({ type: "hello", endpointId: this.opts.endpointId, stationId: this.opts.stationId, capabilities: this.capabilities, language: this.opts.language, observer: this.opts.observer });
			if (this.pingTimer) window.clearInterval(this.pingTimer);
			this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), 20000);
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data !== "string") return;
			let m: HubToEndpointMessage;
			try {
				m = JSON.parse(ev.data) as HubToEndpointMessage;
			} catch {
				return;
			}
			void this.onMessage(m);
		};
		ws.onclose = (ev) => {
			if (this.pingTimer) window.clearInterval(this.pingTimer);
			this.stopListen("cancel");
			if (this.closed) return;
			if (ev.code === 4401) {
				this.cb.onError("The hub rejected this device or session.");
				this.cb.onState("disconnected");
				return;
			}
			this.cb.onState("connecting", ev.code === 4409 ? "replaced by another device" : "reconnecting…");
			const delay = Math.min(30000, 1000 * 2 ** this.retry++);
			window.setTimeout(() => this.connect(), delay);
		};
		ws.onerror = () => {
			/* onclose follows */
		};
	}

	private send(m: EndpointMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
	}

	private async onMessage(m: HubToEndpointMessage): Promise<void> {
		switch (m.type) {
			case "hello":
				this.role = m.role;
				this.cb.onRole(m.role);
				this.cb.onState(m.role === "endpoint" ? "ready" : "observer");
				if (hasAndroid()) window.FlowVoiceAndroid!.setForeground(true, m.role === "endpoint" ? `Voice active on ${m.stationId}` : `Observing ${m.stationId}`);
				if (m.role === "endpoint") this.scheduleIdle(500);
				return;
			case "run":
				this.cb.onRun(m.run);
				return;
			case "event":
				this.cb.onEvent(m.event);
				return;
			case "status":
				this.cb.onState(m.state === "listening" || m.state === "confirming" ? "listening" : m.state === "speaking" ? "speaking" : m.state === "interpreting" || m.state === "committing" ? "thinking" : this.role === "endpoint" ? "ready" : "observer", m.text);
				return;
			case "speak":
				if (this.role !== "endpoint") return;
				this.clearIdleTimer();
				this.stopListen("cancel"); // never listen to our own voice
				this.speakingNow = true;
				this.lastSpokenText = m.text;
				this.cb.onState("speaking", m.text);
				try {
					await this.speak(m.text, m.language, m.promptId);
				} finally {
					this.speakingNow = false;
					this.lastSpokenAt = Date.now();
				}
				this.scheduleIdle(400); // cancelled if the hub opens a prompt window first
				return;
			case "listen.open":
				if (this.role !== "endpoint") return;
				this.bias = m.bias ?? [];
				this.grammar = m.grammar;
				this.openListen(m.promptId, m.maxMs);
				return;
			case "listen.close":
				if (this.listenPromptId !== IDLE) {
					this.stopListen("cancel");
					if (this.role === "endpoint") this.cb.onState("thinking");
					this.scheduleIdle(600);
				}
				return;
			case "released":
				this.role = "observer";
				this.clearIdleTimer();
				this.stopListen("cancel");
				this.cb.onRole("observer");
				this.cb.onState("observer", `microphone taken over by ${m.by ?? "another device"}`);
				return;
			case "navigate":
				this.cb.onNavigate?.(m.page, { runId: m.runId, stationId: m.stationId });
				return;
			case "error":
				this.cb.onError(m.message);
				return;
			default:
				return;
		}
	}

	// ------------------------------------------------------------ TTS

	private speak(text: string, language: string, promptId: string): Promise<void> {
		if (hasAndroid()) {
			// Resolve only when Android reports the utterance done (flowVoiceBridge.onSpoken); resolving
			// early would re-arm the idle mic, whose startListening() stops TTS mid-sentence.
			this.pendingSpoken?.finish();
			return new Promise((resolve) => {
				let done = false;
				let timer: number | undefined;
				const finish = () => {
					if (done) return;
					done = true;
					if (timer) window.clearTimeout(timer);
					if (this.pendingSpoken?.promptId === promptId) this.pendingSpoken = undefined;
					this.send({ type: "spoken", promptId });
					resolve();
				};
				this.pendingSpoken = { promptId, finish };
				timer = window.setTimeout(finish, 4000 + text.length * 120); // safety net if the engine never calls back
				window.FlowVoiceAndroid!.speak(text, language, promptId);
			});
		}
		return new Promise((resolve) => {
			if (!("speechSynthesis" in window)) {
				this.send({ type: "spoken", promptId });
				resolve();
				return;
			}
			window.speechSynthesis.cancel();
			const u = new SpeechSynthesisUtterance(text);
			u.lang = language.length === 2 ? { en: "en-GB", no: "nb-NO", nb: "nb-NO", sv: "sv-SE", de: "de-DE", fr: "fr-FR", da: "da-DK" }[language] ?? language : language;
			u.rate = 0.95;
			let finished = false;
			const done = () => {
				if (finished) return;
				finished = true;
				this.send({ type: "spoken", promptId });
				resolve();
			};
			u.onend = done;
			u.onerror = done;
			window.speechSynthesis.speak(u);
			// Chrome sometimes never fires onend for long utterances
			window.setTimeout(done, 3000 + text.length * 120);
		});
	}

	// ------------------------------------------------------------ STT

	private openListen(promptId: string, maxMs: number): void {
		this.clearIdleTimer();
		this.stopListen("cancel");
		this.listenPromptId = promptId;
		this.lastFinal = "";
		if (this.opts.holdToAnswer && !this.handsFree && promptId !== IDLE && !this.pttDown) {
			// noisy bridge: wait for the crew to hold the button instead of listening to the room
			this.armed = { maxMs };
			this.cb.onState("ready", "hold to talk to answer");
			return;
		}
		this.armed = undefined;
		this.cb.onState("listening");
		if (this.capabilities.localStt) this.startRecognition(maxMs);
		else void this.startStreaming(maxMs);
	}

	private stopListen(reason: "silence" | "ptt" | "timeout" | "cancel"): void {
		if (this.listenTimer) window.clearTimeout(this.listenTimer);
		this.listenTimer = undefined;
		if (!this.listenPromptId) return;
		this.listenPromptId = undefined;
		if (this.armed) {
			// the window closed before anyone held the button: nothing to stop
			this.armed = undefined;
			void reason;
			return;
		}
		if (this.capabilities.localStt) {
			if (hasAndroid()) window.FlowVoiceAndroid!.stopListening();
			else {
				try {
					this.recognition?.abort();
				} catch {
					/* ignore */
				}
				this.recognition = undefined;
			}
		} else if (this.worklet) this.worklet.port.postMessage({ type: "stop" });
		void reason;
	}

	private endListen(reason: "silence" | "ptt" | "timeout" | "cancel"): void {
		if (!this.listenPromptId) return;
		if (this.listenPromptId === IDLE) {
			this.stopListen(reason);
			this.scheduleIdle(300);
			return;
		}
		const localStt = this.capabilities.localStt;
		this.stopListen(reason);
		if (!localStt) this.send({ type: "audio.end", reason });
		else if (!this.lastFinal) this.send({ type: "audio.end", reason });
	}

	private deliverTranscript(text: string, confidence: number, final: boolean): void {
		const idle = this.listenPromptId === IDLE;
		if (final && this.isEcho(text)) {
			if (idle) this.scheduleIdle(200);
			return;
		}
		this.cb.onTranscript(text, final);
		if (final) {
			this.lastFinal = text;
			this.listenPromptId = undefined;
			if (this.listenTimer) window.clearTimeout(this.listenTimer);
			this.cb.onState("thinking");
		}
		this.send({ type: "transcript", text, confidence, final });
		if (final && idle) this.scheduleIdle(400);
	}

	/** The open mic can pick up the tail of our own TTS; drop transcripts that repeat what was just spoken. */
	private isEcho(text: string): boolean {
		if (Date.now() - this.lastSpokenAt > ECHO_GUARD_MS && !this.speakingNow) return false;
		const norm = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
		const a = norm(text);
		const b = norm(this.lastSpokenText);
		if (!a || !b) return false;
		if (b.includes(a) || a.includes(b)) return true;
		const words = a.split(" ");
		const hits = words.filter((w) => w.length > 3 && b.includes(w)).length;
		return words.length >= 3 && hits / words.length >= 0.6;
	}

	private startRecognition(maxMs: number): void {
		const stt = this.opts.answerLanguage || this.opts.language;
		if (hasAndroid()) {
			const a = window.FlowVoiceAndroid!;
			// English is always understood by the hub: let the recogniser switch to it when the checklist is in another language
			const extra = /^en/i.test(stt) ? "" : "en-US";
			// narrow answer set + offline grammar model on the phone: the recogniser can only return allowed words
			if (this.grammar?.length && a.startListeningGrammar && a.hasGrammarStt?.(stt)) {
				a.startListeningGrammar(stt, JSON.stringify(this.grammar), maxMs, this.listenPromptId ?? "");
				return;
			}
			if (a.startListeningWith) a.startListeningWith(stt, extra, this.bias.join(","), maxMs, this.listenPromptId ?? "");
			else if (a.startListeningIn) a.startListeningIn(stt, extra, maxMs, this.listenPromptId ?? "");
			else a.startListening(stt, maxMs, this.listenPromptId ?? "");
			return;
		}
		const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
		if (!Ctor) {
			this.cb.onError("This browser has no speech recognition; type the answer instead.");
			return;
		}
		const rec = new Ctor();
		rec.lang = stt.length === 2 ? { en: "en-GB", no: "nb-NO", nb: "nb-NO", sv: "sv-SE", de: "de-DE", fr: "fr-FR", da: "da-DK" }[stt] ?? stt : stt;
		rec.interimResults = true;
		rec.continuous = false;
		rec.maxAlternatives = 1;
		rec.onresult = (ev: SpeechRecognitionEvent) => {
			let interim = "";
			for (let i = ev.resultIndex; i < ev.results.length; i++) {
				const r = ev.results[i];
				if (r.isFinal) {
					this.deliverTranscript(r[0].transcript, r[0].confidence || 0.9, true);
					return;
				}
				interim += r[0].transcript;
			}
			if (interim) this.deliverTranscript(interim, 0, false);
		};
		rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
			if (ev.error === "no-speech" || ev.error === "aborted") return;
			this.cb.onError(`speech recognition: ${ev.error}`);
		};
		rec.onend = () => {
			if (this.recognition === rec) {
				this.recognition = undefined;
				if (this.listenPromptId && !this.pttDown) this.endListen("silence");
			}
		};
		this.recognition = rec;
		try {
			rec.start();
		} catch (err) {
			this.cb.onError(`microphone: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.listenTimer = window.setTimeout(() => this.endListen("timeout"), maxMs);
	}

	private stopRecognition(): void {
		try {
			this.recognition?.stop(); // delivers the final result, then onend
		} catch {
			/* ignore */
		}
	}

	private async ensureMic(): Promise<void> {
		if (this.stream) return;
		this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
		const Ctx = window.AudioContext ?? window.webkitAudioContext;
		this.audioCtx = new Ctx({ sampleRate: 48000 });
		const workletSrc = `
			class Pcm16k extends AudioWorkletProcessor {
				constructor() { super(); this.active = false; this.acc = 0; this.buf = []; this.port.onmessage = (e) => { this.active = e.data.type === "start"; if (!this.active) this.buf = []; }; }
				process(inputs) {
					if (!this.active || !inputs[0] || !inputs[0][0]) return true;
					const input = inputs[0][0];
					const ratio = sampleRate / 16000;
					for (let i = 0; i < input.length; i++) {
						this.acc += 1;
						if (this.acc >= ratio) { this.acc -= ratio; const s = Math.max(-1, Math.min(1, input[i])); this.buf.push(s < 0 ? s * 0x8000 : s * 0x7fff); }
					}
					if (this.buf.length >= 320) { const out = new Int16Array(this.buf.splice(0, 320)); this.port.postMessage(out.buffer, [out.buffer]); }
					return true;
				}
			}
			registerProcessor("pcm16k", Pcm16k);`;
		const url = URL.createObjectURL(new Blob([workletSrc], { type: "application/javascript" }));
		await this.audioCtx.audioWorklet.addModule(url);
		const src = this.audioCtx.createMediaStreamSource(this.stream);
		this.worklet = new AudioWorkletNode(this.audioCtx, "pcm16k");
		this.worklet.port.onmessage = (e) => {
			if (this.listenPromptId && this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data as ArrayBuffer);
		};
		src.connect(this.worklet);
		this.worklet.connect(this.audioCtx.destination);
	}

	private async startStreaming(maxMs: number): Promise<void> {
		try {
			await this.ensureMic();
			await this.audioCtx?.resume();
		} catch (err) {
			this.cb.onError(`microphone: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.worklet?.port.postMessage({ type: "start" });
		this.listenTimer = window.setTimeout(() => this.endListen("timeout"), maxMs);
	}
}
