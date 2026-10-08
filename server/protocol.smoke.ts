import assert from "node:assert/strict";
import { BUTTON_DOUBLE_MS, BUTTON_HOLD_MS, bleIsRelease, bleKeyName, bleKeySlot, buttonKeyName, buttonPresses, stationButtons, type ButtonAction } from "./protocol.js";

export function run(): void {
	// key names: the DOM code, else the key, letters and digits only
	assert.equal(buttonKeyName("PageDown", "PageDown"), "PageDown");
	assert.equal(buttonKeyName("", "AudioVolumeUp"), "AudioVolumeUp");
	assert.equal(buttonKeyName("", " "), "");
	assert.equal(buttonKeyName("Key<A>"), "KeyA");

	// Bluetooth push-to-talk buttons: slot + characteristic + payload make the key, and it survives the key-name filter
	assert.equal(bleKeyName(1, "0000ffe1-0000-1000-8000-00805f9b34fb", [1]), "Ble1FFE101");
	assert.equal(bleKeyName(2, "0000FFE1-0000-1000-8000-00805F9B34FB", new Uint8Array([0])), "Ble2FFE100");
	assert.equal(bleKeyName(3, "6e400003-b5a3-f393-e0a9-e50e24dcca9e", [0x2b, 0x50, 0x54, 0x54, 0x3d, 0x50, 0x0d]), "Ble36E4000032B5054543D50");
	assert.equal(bleKeyName(1, "0000ffe1-0000-1000-8000-00805f9b34fb", []), "Ble1FFE1");
	assert.equal(buttonKeyName(bleKeyName(1, "0000ffe1-0000-1000-8000-00805f9b34fb", [255, 1])), "Ble1FFE1FF01");
	assert.deepEqual(stationButtons([{ key: "Ble1FFE101", action: "talk" }]), [{ key: "Ble1FFE101", action: "talk" }]);
	// only zeros = the button was let go
	assert.equal(bleIsRelease([0]), true);
	assert.equal(bleIsRelease(new Uint8Array([0, 0])), true);
	assert.equal(bleIsRelease([1]), false);
	assert.equal(bleIsRelease([0, 2]), false);
	assert.equal(bleIsRelease([]), false);
	assert.equal(bleKeySlot("Ble2FFE101"), 2);
	assert.equal(bleKeySlot("PageDown"), undefined);
	assert.equal(bleKeySlot("Ble9FFE101"), undefined);

	// station buttons: at most three, known actions only, one action per key
	// press / two quick presses / hold: talk takes the whole press, unknown actions are dropped
	assert.deepEqual(stationButtons([{ key: "Enter", action: "accept", double: "override", hold: "back" }]), [{ key: "Enter", action: "accept", double: "override", hold: "back" }]);
	assert.deepEqual(stationButtons([{ key: "Enter", action: "talk", double: "override", hold: "back" }]), [{ key: "Enter", action: "talk" }]);
	assert.deepEqual(stationButtons([{ key: "Enter", action: "accept", double: "talk", hold: "nope" }]), [{ key: "Enter", action: "accept" }]);
	pressReader();

	assert.equal(stationButtons(undefined), undefined);
	assert.equal(stationButtons([]), undefined);
	assert.equal(stationButtons([{ key: "Enter", action: "explode" }]), undefined);
	assert.deepEqual(stationButtons([{ key: "Enter", action: "accept", junk: 1 }]), [{ key: "Enter", action: "accept" }]);
	assert.deepEqual(
		stationButtons([
			{ key: "Enter", action: "accept" },
			{ key: "Enter", action: "next" },
			{ key: "Page Down", action: "override" },
			{ key: "", action: "next" },
			{ key: "KeyB", action: "repeat" },
		]),
		[
			{ key: "Enter", action: "accept" },
			{ key: "PageDown", action: "override" },
			{ key: "", action: "next" },
		],
	);
	// a slot may wait for its key: two unbound ones do not count as the same key
	assert.equal(stationButtons([{ key: "", action: "accept" }, { key: "", action: "next" }])?.length, 2);
}

/** `buttonPresses` against a fake clock. */
function pressReader(): void {
	let now = 0;
	let timers: { at: number; fn: () => void; id: number }[] = [];
	let next = 0;
	const clock = { set: (fn: () => void, ms: number) => (timers.push({ at: now + ms, fn, id: ++next }), next), clear: (id: unknown) => (timers = timers.filter((t) => t.id !== id)), now: () => now };
	const tick = (ms: number) => {
		const until = now + ms;
		for (;;) {
			const t = timers.filter((x) => x.at <= until).sort((a, b) => a.at - b.at)[0];
			if (!t) break;
			now = t.at;
			timers = timers.filter((x) => x !== t);
			t.fn();
		}
		now = until;
	};
	const ran: string[] = [];
	const r = buttonPresses(
		[
			{ key: "Enter", action: "accept", double: "override", hold: "back" },
			{ key: "Space", action: "talk" },
			{ key: "KeyN", action: "next" },
			{ key: "Ble1FFE101", action: "accept", double: "override", hold: "back" },
		],
		(a: ButtonAction, down: boolean) => ran.push(down ? a : `${a}:up`),
		clock,
	);
	const click = (key: string, held = 80) => {
		r.press(key, true);
		tick(held);
		r.press(key, false);
	};
	const take = () => ran.splice(0).join(",");
	assert.equal(r.press("KeyZ", true), false, "a key no button has is not ours");
	// one press: runs once no second press follows
	click("Enter");
	assert.equal(take(), "");
	tick(BUTTON_DOUBLE_MS);
	assert.equal(take(), "accept");
	// two quick presses: only the double
	click("Enter");
	tick(120);
	click("Enter");
	tick(BUTTON_DOUBLE_MS * 3);
	assert.equal(take(), "override");
	// held: runs at the hold time while still down, the release does nothing
	r.press("Enter", true);
	tick(BUTTON_HOLD_MS - 1);
	assert.equal(take(), "");
	tick(1);
	assert.equal(take(), "back");
	r.press("Enter", true); // key repeat
	tick(500);
	r.press("Enter", false);
	tick(BUTTON_DOUBLE_MS * 3);
	assert.equal(take(), "");
	// two slow presses: two singles
	click("Enter");
	tick(BUTTON_DOUBLE_MS + 50);
	click("Enter");
	tick(BUTTON_DOUBLE_MS + 50);
	assert.equal(take(), "accept,accept");
	// plain buttons as before: at once, talk with its release, repeats ignored
	r.press("KeyN", true);
	r.press("KeyN", true);
	r.press("KeyN", false);
	r.press("Space", true);
	r.press("Space", false);
	assert.equal(take(), "next,next:up,talk,talk:up");
	// a Bluetooth button that reports its release works like a key
	click("Ble1FFE101");
	tick(BUTTON_DOUBLE_MS);
	assert.equal(take(), "accept");
	// a click-only Bluetooth button: released only just before its next press. The first press is read late, after that each press is a whole click
	r.press("Ble1FFE101", true);
	tick(1000);
	r.press("Ble1FFE101", false);
	r.press("Ble1FFE101", true);
	tick(BUTTON_DOUBLE_MS);
	assert.equal(take(), "accept,accept");
	tick(3000);
	assert.equal(take(), "", "a click-only button is never held");
	r.press("Ble1FFE101", false);
	r.press("Ble1FFE101", true);
	tick(100);
	r.press("Ble1FFE101", false);
	r.press("Ble1FFE101", true);
	tick(BUTTON_DOUBLE_MS * 3);
	assert.equal(take(), "override");
	r.stop();
}
