/** Light / dark / system, remembered per device, applied as data-theme on <html>. */
export type Theme = "light" | "dark" | "system";

export function readTheme(): Theme {
	try {
		const v = localStorage.getItem("fv.theme");
		return v === "light" || v === "dark" ? v : "system";
	} catch {
		return "system";
	}
}

export function applyTheme(t: Theme): void {
	const root = document.documentElement;
	if (t === "system") root.removeAttribute("data-theme");
	else root.setAttribute("data-theme", t);
	const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0a0f19" : "#ffffff");
	window.FlowVoiceAndroid?.setTheme?.(dark ? "dark" : "light");
}

export function saveTheme(t: Theme): void {
	try {
		if (t === "system") localStorage.removeItem("fv.theme");
		else localStorage.setItem("fv.theme", t);
	} catch {
		/* private mode */
	}
	applyTheme(t);
}
