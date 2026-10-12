/**
 * Client mode. The *mobile client* only runs checklists and drives voice: the Android agent
 * (WebView with `window.FlowVoiceAndroid`), and any phone or tablet browser / installed PWA. Everything
 * else — Admin, theme, station authoring — belongs to the desktop browser.
 * `?mobile=1` forces the mobile layout on a desktop, `?mobile=0` forces the desktop layout on a
 * phone (both remembered in localStorage).
 */
export function isMobileClient(): boolean {
	if (typeof window === "undefined") return false;
	// direct links: /client is always the run-and-voice client, /admin always the desktop admin (neither is remembered)
	if (/^\/client(\/|$)/.test(location.pathname)) return true;
	if (/^\/admin(\/|$)/.test(location.pathname)) return false;
	try {
		const q = new URLSearchParams(location.search).get("mobile");
		if (q === "1" || q === "0") localStorage.setItem("fv.mobile", q);
		const saved = localStorage.getItem("fv.mobile");
		if (saved === "1") return true;
		if (saved === "0") return false;
	} catch {
		/* storage unavailable: fall through to detection */
	}
	if (window.FlowVoiceAndroid) return true;
	const ua = navigator.userAgent;
	if (/FlowVoiceAndroid|Android|iPhone|iPod|iPad|Mobile/i.test(ua)) return true;
	// iPadOS reports a desktop Safari user agent: a Mac with a touch screen is a tablet
	return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
}

/** The app put the screen into full screen itself (a checklist started by button), so it may also take it out again. */
let fullByApp = false;
/**
 * The checklist fills the whole screen: the Android agent hides its system bars; a browser asks for full screen,
 * which it only allows shortly after a key press or click (a Bluetooth button press is neither: then nothing happens).
 */
export function enterFullscreen(): void {
	const android = window.FlowVoiceAndroid;
	if (android?.setFullscreen) {
		android.setFullscreen(true);
		fullByApp = true;
		return;
	}
	if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
	document.documentElement.requestFullscreen({ navigationUI: "hide" }).then(
		() => {
			fullByApp = true;
		},
		() => {},
	);
}
/** Back from full screen, only when `enterFullscreen` put it there (a kiosk or F11 full screen stays). */
export function exitFullscreen(): void {
	if (!fullByApp) return;
	fullByApp = false;
	const android = window.FlowVoiceAndroid;
	if (android?.setFullscreen) android.setFullscreen(false);
	else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}
