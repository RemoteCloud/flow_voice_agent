/**
 * What this device is, for the hub (`hello.capabilities.device`, shown in Admin → Stations). Inside the Android
 * agent the app's `deviceInfo()` (DeviceInfo.kt: make, Android version, memory, audio routes, speech engines …)
 * is the body and the web bundle adds its own line; in a browser it is what a page may know: browser and OS from
 * the user agent (and User-Agent Client Hints when the browser gives them), screen, cores, memory class, network,
 * speech APIs, microphones (count and labels once the mic was allowed), voices. No identifiers.
 *
 * The slow parts (voices, microphones) are gathered once in the background (`primeDeviceInfo`) and whatever is
 * known at hello time goes out; a reconnect carries the rest.
 */
import type { DeviceInfo, DeviceValue } from "../../server/protocol.js";
import { WEB_BUILD } from "./build.js";

let cache: DeviceInfo | undefined;
let primed = false;

/** Start gathering the slow facts; safe to call many times. */
export function primeDeviceInfo(): void {
	if (primed || typeof window === "undefined") return;
	primed = true;
	void gatherAsync();
}

/** Everything known right now (fast facts fresh, slow facts as last gathered). */
export function collectDeviceInfo(): DeviceInfo {
	primeDeviceInfo();
	const android = androidInfo();
	const web: Record<string, DeviceValue> = { build: WEB_BUILD, ...browserFacts() };
	if (android) return { ...android, web };
	const info: DeviceInfo = { ...(cache ?? {}), ...browserTopics(), web };
	return info;
}

function androidInfo(): DeviceInfo | undefined {
	const a = window.FlowVoiceAndroid;
	if (!a?.deviceInfo) return undefined;
	try {
		const v = JSON.parse(a.deviceInfo()) as unknown;
		return v && typeof v === "object" && !Array.isArray(v) ? (v as DeviceInfo) : undefined;
	} catch {
		return undefined;
	}
}

/** The web bundle's own view, also inside the app: page URL kind, display mode, language, online flag. */
function browserFacts(): Record<string, DeviceValue> {
	const o: Record<string, DeviceValue> = {};
	try {
		o.path = location.pathname;
		o.standalone = window.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
		o.online = navigator.onLine;
		o.language = navigator.language;
		o.languages = [...(navigator.languages ?? [])].slice(0, 8);
		o.cookies = navigator.cookieEnabled;
		o.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
		o.clock = new Date().toISOString();
		o.serviceWorker = "serviceWorker" in navigator;
		o.localStorage = (() => {
			try {
				localStorage.setItem("fv.probe", "1");
				localStorage.removeItem("fv.probe");
				return true;
			} catch {
				return false;
			}
		})();
	} catch {
		/* best effort */
	}
	return o;
}

interface UaData {
	brands?: { brand: string; version: string }[];
	mobile?: boolean;
	platform?: string;
	getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>>;
}

/** Fast facts about the browser and the machine it runs on. */
function browserTopics(): DeviceInfo {
	const nav = navigator as Navigator & { userAgentData?: UaData; deviceMemory?: number; connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean; type?: string }; bluetooth?: unknown; wakeLock?: unknown };
	const ua = nav.userAgent;
	const b = parseUa(ua);
	const browser: Record<string, DeviceValue> = { name: b.browser, version: b.version, userAgent: ua, vendor: nav.vendor ?? "", engine: b.engine };
	if (nav.userAgentData?.brands?.length) browser.brands = nav.userAgentData.brands.map((x) => `${x.brand} ${x.version}`).slice(0, 6);
	const os: Record<string, DeviceValue> = { name: b.os, version: b.osVersion, platform: nav.userAgentData?.platform ?? nav.platform ?? "" };
	const device: Record<string, DeviceValue> = { mobile: nav.userAgentData?.mobile ?? /Mobi|Android/i.test(ua), touchPoints: nav.maxTouchPoints ?? 0, model: b.model };
	const screenT: Record<string, DeviceValue> = {
		widthPx: Math.round(screen.width * devicePixelRatio),
		heightPx: Math.round(screen.height * devicePixelRatio),
		widthCss: screen.width,
		heightCss: screen.height,
		availWidth: screen.availWidth,
		availHeight: screen.availHeight,
		pixelRatio: devicePixelRatio,
		colorDepth: screen.colorDepth,
		orientation: screen.orientation?.type ?? "",
		viewportWidth: innerWidth,
		viewportHeight: innerHeight,
		darkMode: window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false,
		reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
	};
	const cpu: Record<string, DeviceValue> = { cores: nav.hardwareConcurrency ?? 0 };
	const memory: Record<string, DeviceValue> = {};
	if (typeof nav.deviceMemory === "number") memory.classGb = nav.deviceMemory;
	const perf = performance as Performance & { memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number } };
	if (perf.memory) {
		memory.jsHeapLimitMb = Math.round(perf.memory.jsHeapSizeLimit / 1048576);
		memory.jsHeapUsedMb = Math.round(perf.memory.usedJSHeapSize / 1048576);
	}
	const network: Record<string, DeviceValue> = { online: nav.onLine };
	if (nav.connection) {
		if (nav.connection.type) network.type = nav.connection.type;
		if (nav.connection.effectiveType) network.effectiveType = nav.connection.effectiveType;
		if (typeof nav.connection.downlink === "number") network.downlinkMbps = nav.connection.downlink;
		if (typeof nav.connection.rtt === "number") network.rttMs = nav.connection.rtt;
		if (typeof nav.connection.saveData === "boolean") network.saveData = nav.connection.saveData;
	}
	const speech: Record<string, DeviceValue> = {
		recognition: !!(window.SpeechRecognition ?? window.webkitSpeechRecognition),
		synthesis: "speechSynthesis" in window,
		voiceCount: (() => {
			try {
				return speechSynthesis.getVoices().length;
			} catch {
				return 0;
			}
		})(),
	};
	const features: Record<string, DeviceValue> = {
		webBluetooth: !!nav.bluetooth,
		wakeLock: !!nav.wakeLock,
		mediaDevices: !!nav.mediaDevices?.getUserMedia,
		audioWorklet: typeof AudioWorkletNode !== "undefined",
		webSocket: typeof WebSocket !== "undefined",
		secureContext: window.isSecureContext,
		pdfViewer: (nav as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled ?? false,
	};
	return { browser, os, device, screen: screenT, cpu, memory, network, speech, features };
}

/** Voices and microphones take a moment (and a permission) — gathered once, merged on the next hello. */
async function gatherAsync(): Promise<void> {
	const slow: DeviceInfo = {};
	try {
		const nav = navigator as Navigator & { userAgentData?: UaData };
		const hi = await nav.userAgentData?.getHighEntropyValues?.(["platformVersion", "model", "architecture", "bitness", "fullVersionList"]);
		if (hi) {
			const os: Record<string, DeviceValue> = {};
			if (typeof hi.platformVersion === "string" && hi.platformVersion) os.platformVersion = hi.platformVersion;
			if (typeof hi.architecture === "string" && hi.architecture) os.architecture = `${hi.architecture}${typeof hi.bitness === "string" && hi.bitness ? `-${hi.bitness}` : ""}`;
			if (Object.keys(os).length) slow.osHints = os;
			if (typeof hi.model === "string" && hi.model) slow.deviceHints = { model: hi.model };
			if (Array.isArray(hi.fullVersionList)) slow.browserHints = { versions: (hi.fullVersionList as { brand: string; version: string }[]).map((x) => `${x.brand} ${x.version}`).slice(0, 6) };
		}
	} catch {
		/* no client hints */
	}
	try {
		const voices = await voicesReady();
		const byLang: Record<string, number> = {};
		for (const v of voices) byLang[v.lang.slice(0, 2).toLowerCase()] = (byLang[v.lang.slice(0, 2).toLowerCase()] ?? 0) + 1;
		const ours = voices.filter((v) => /^(en|sv|n[bno]|fr|de|da)/i.test(v.lang)).map((v) => `${v.name} (${v.lang}${v.localService ? "" : ", online"})`).slice(0, 40);
		slow.voices = { count: voices.length, perLanguage: byLang, ours };
	} catch {
		/* no synthesis */
	}
	try {
		if (navigator.mediaDevices?.enumerateDevices) {
			const devs = await navigator.mediaDevices.enumerateDevices();
			const mics = devs.filter((d) => d.kind === "audioinput");
			const outs = devs.filter((d) => d.kind === "audiooutput");
			slow.audio = {
				microphones: mics.length,
				microphoneNames: mics.map((d) => d.label).filter(Boolean).slice(0, 10),
				outputs: outs.length,
				outputNames: outs.map((d) => d.label).filter(Boolean).slice(0, 10),
				permissionKnown: mics.some((d) => !!d.label),
			};
			const caps = (navigator.mediaDevices as MediaDevices & { getSupportedConstraints?(): Record<string, boolean> }).getSupportedConstraints?.();
			if (caps) (slow.audio as Record<string, DeviceValue>).constraints = Object.keys(caps).filter((k) => /echo|noise|gain|sampleRate|channel/i.test(k));
		}
	} catch {
		/* no media devices */
	}
	try {
		const est = await (navigator.storage as StorageManager & { estimate?(): Promise<{ quota?: number; usage?: number }> })?.estimate?.();
		if (est) slow.storage = { quotaMb: Math.round((est.quota ?? 0) / 1048576), usageMb: Math.round((est.usage ?? 0) / 1048576) };
	} catch {
		/* no storage estimate */
	}
	cache = slow;
}

function voicesReady(): Promise<SpeechSynthesisVoice[]> {
	return new Promise((resolve) => {
		if (!("speechSynthesis" in window)) return resolve([]);
		const now = speechSynthesis.getVoices();
		if (now.length) return resolve(now);
		const t = window.setTimeout(() => resolve(speechSynthesis.getVoices()), 2500);
		speechSynthesis.addEventListener(
			"voiceschanged",
			() => {
				window.clearTimeout(t);
				resolve(speechSynthesis.getVoices());
			},
			{ once: true },
		);
	});
}

/** Browser / engine / OS / model out of a user agent string — rough but enough for "which Chrome on which Windows". Pure. */
export function parseUa(ua: string): { browser: string; version: string; engine: string; os: string; osVersion: string; model: string } {
	const m = (re: RegExp): string => re.exec(ua)?.[1] ?? "";
	let browser = "";
	let version = "";
	const pairs: [string, RegExp][] = [
		["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
		["Opera", /OPR\/([\d.]+)/],
		["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
		["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
		["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
		["Safari", /Version\/([\d.]+).*Safari/],
	];
	for (const [name, re] of pairs) {
		const v = m(re);
		if (v) {
			browser = name;
			version = v;
			break;
		}
	}
	if (/; wv\)/.test(ua) || /FlowVoiceAndroid/.test(ua)) browser = browser ? `${browser} WebView` : "Android WebView";
	const engine = /Gecko\/\d/.test(ua) ? "Gecko" : /AppleWebKit/.test(ua) && !/Chrome|CriOS/.test(ua) ? "WebKit" : /AppleWebKit/.test(ua) ? "Blink" : "";
	let os = "";
	let osVersion = "";
	let model = "";
	if (/Windows NT/.test(ua)) {
		os = "Windows";
		const nt = m(/Windows NT ([\d.]+)/);
		osVersion = nt === "10.0" ? "10/11" : nt === "6.3" ? "8.1" : nt === "6.1" ? "7" : nt;
	} else if (/Android/.test(ua)) {
		os = "Android";
		osVersion = m(/Android ([\d.]+)/);
		model = m(/Android [\d.]+; (?:[a-z]{2}-[A-Za-z]{2}; )?([^;)]+?)(?: Build|\)|;)/);
	} else if (/iPhone|iPad|iPod/.test(ua)) {
		os = "iOS";
		osVersion = m(/OS (\d+[._]\d+(?:[._]\d+)?)/).replace(/_/g, ".");
		model = m(/\((iPhone|iPad|iPod)/);
	} else if (/CrOS/.test(ua)) {
		os = "ChromeOS";
		osVersion = m(/CrOS \w+ ([\d.]+)/);
	} else if (/Mac OS X/.test(ua)) {
		os = "macOS";
		osVersion = m(/Mac OS X (\d+[._]\d+(?:[._]\d+)?)/).replace(/_/g, ".");
	} else if (/Linux/.test(ua)) {
		os = "Linux";
		if (/aarch64|armv/.test(ua)) model = "ARM (Raspberry Pi?)";
	}
	return { browser, version, engine, os, osVersion, model };
}
