/**
 * Hardware buttons of a station (Admin → Stations → Buttons): a Bluetooth or USB button that the computer or
 * tablet sees as a keyboard. The station names up to three keys and what each one does; this hook listens for
 * them anywhere in the client (not in Admin, not while typing) and hands the press on. In a browser the keys
 * arrive as key events; in the Android agent the app catches them first (volume and media keys never reach a
 * page) and reports them through `window.flowVoiceButton`. Push-to-talk buttons that are not keyboards come in
 * over Bluetooth LE (`ble.ts`) under a key name of their own ("BleFFE101").
 */
import { useEffect, useRef } from "react";
import { BLE_KEY_PREFIX, bleKeySlot, buttonKeyName, buttonPresses, type ButtonAction, type StationButton } from "../../server/protocol.js";
import { onBleKey } from "./ble.js";
import { parseRoute } from "./router.js";

export const BUTTON_ACTION_TEXT: Record<ButtonAction, string> = {
	accept: "Accept item: done / yes / confirm",
	no: "No: not done / wrong, ask again",
	override: "Override item: skip it, it is asked again at the end",
	next: "Next item",
	back: "Previous item",
	repeat: "Repeat the question",
	talk: "Hold to talk",
	pause: "Pause / resume",
};

/** Keys a button commonly sends, for picking one without the button at hand. */
export const COMMON_BUTTON_KEYS = ["Enter", "Space", "ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "PageDown", "PageUp", "AudioVolumeUp", "AudioVolumeDown", "MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious", "F5", "Escape", "Tab", "KeyB"];

const KEY_TEXT: Record<string, string> = { Enter: "Enter", Space: "Space", ArrowRight: "Arrow right", ArrowLeft: "Arrow left", ArrowUp: "Arrow up", ArrowDown: "Arrow down", PageDown: "Page down", PageUp: "Page up", AudioVolumeUp: "Volume up", AudioVolumeDown: "Volume down", MediaPlayPause: "Play / pause", MediaTrackNext: "Next track", MediaTrackPrevious: "Previous track", Escape: "Esc" };

/** A key name as people know it: "Page down", "B", "Volume up". */
export function buttonKeyText(key: string): string {
	const slot = bleKeySlot(key);
	if (slot) return `Bluetooth button ${slot} (${key.slice(BLE_KEY_PREFIX.length + 1)})`;
	return KEY_TEXT[key] ?? key.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit(?=\d$)/, "");
}

/** Keys the station has bound (keyboard-type), as the Android agent was last told. */
let boundKeys = "";
/** A button is being set up ("Press the button now…"): presses are for the setup screen, no action runs. */
let learning = false;
// the app keeps bound keys from the page and reports them itself; while learning it reports every hardware key
const pushKeys = () => window.FlowVoiceAndroid?.setButtonKeys?.(learning ? "*" : boundKeys);
export function setButtonLearning(on: boolean): void {
	learning = on;
	pushKeys();
}
/** Buttons panels on screen: a panel takes the press of a button nobody knows yet itself. Returns the "closed" call. */
let panels = 0;
export function buttonPanelOpen(): () => void {
	panels++;
	return () => {
		panels--;
	};
}

const typing = () => {
	const el = document.activeElement as HTMLElement | null;
	return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/** `onButton(action, down)`: down = pressed, up = released (only "talk" cares about the release). */
export function useStationButtons(buttons: StationButton[] | undefined, onButton: (action: ButtonAction, down: boolean) => void, onLearn?: (buttons: StationButton[]) => Promise<void>): void {
	const cb = useRef(onButton);
	cb.current = onButton;
	// A button added in Admin without its key ("Button 1: Accept item") is finished by the first press of a connected
	// Bluetooth button nobody knows yet: the row takes that key, it is saved to the station, and the press counts.
	const learn = useRef(onLearn);
	learn.current = onLearn;
	const all = useRef(buttons);
	all.current = buttons;
	const waiting = (buttons ?? []).some((b) => !b.key);
	useEffect(() => {
		if (!waiting) return;
		let busy = false;
		return onBleKey((key, down) => {
			const list = all.current ?? [];
			if (!down || busy || panels > 0 || learning || parseRoute(location.hash).page === "admin") return;
			if (!key.startsWith(BLE_KEY_PREFIX) || list.some((b) => b.key === key)) return;
			const i = list.findIndex((b) => !b.key);
			const save = learn.current;
			if (i < 0 || !save) return;
			busy = true;
			const action = list[i]!.action;
			save(list.map((b, k) => (k === i ? { ...b, key } : b)))
				.then(
					// push-to-talk needs the hold, which this first press no longer is
					() => action !== "talk" && cb.current(action, true),
					() => {},
				)
				.finally(() => {
					busy = false;
				});
		});
	}, [waiting]);
	const bound = (buttons ?? []).filter((b) => b.key);
	const sig = JSON.stringify(bound);
	useEffect(() => {
		const list = JSON.parse(sig) as StationButton[];
		if (!list.length) return;
		const off = () => learning || parseRoute(location.hash).page === "admin";
		// one press, two quick presses or held down: `buttonPresses` tells them apart and runs the action for each
		const reader = buttonPresses(list, (action, down) => cb.current(action, down), { set: (fn, ms) => window.setTimeout(fn, ms), clear: (t) => window.clearTimeout(t as number), now: () => Date.now() });
		const fire = reader.press;
		const onKey = (e: KeyboardEvent) => {
			if (off() || typing() || e.ctrlKey || e.altKey || e.metaKey) return;
			if (!fire(buttonKeyName(e.code, e.key), e.type === "keydown")) return;
			// the key belongs to the button now: no click on a focused control, no page scroll, no Space push-to-talk
			e.preventDefault();
			e.stopPropagation();
		};
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("keyup", onKey, true);
		// everything that is not a browser key event: Bluetooth push-to-talk buttons (Web Bluetooth, or the Android
		// app) and the keys the Android app catches before the page (`ble.ts` passes them all on)
		const offBle = onBleKey((key, down) => {
			if (!off()) fire(key, down);
		});
		boundKeys = list.map((b) => b.key).filter((k) => !k.startsWith(BLE_KEY_PREFIX)).join(",");
		pushKeys();
		return () => {
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("keyup", onKey, true);
			offBle();
			reader.stop();
			boundKeys = "";
			pushKeys();
		};
	}, [sig]);
}
