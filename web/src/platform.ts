/**
 * Client mode. The *mobile client* only runs checklists and drives voice: the Android agent
 * (WebView with `window.FlowVoiceAndroid`), and any phone or tablet browser / installed PWA. Everything
 * else — Admin, theme, station authoring — belongs to the desktop browser.
 * `?mobile=1` forces the mobile layout on a desktop, `?mobile=0` forces the desktop layout on a
 * phone (both remembered in localStorage).
 */
export function isMobileClient(): boolean {
	if (typeof window === "undefined") return false;
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
