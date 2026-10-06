import assert from "node:assert/strict";
import { bleIsRelease, bleKeyName, bleKeySlot, buttonKeyName, stationButtons } from "./protocol.js";

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
