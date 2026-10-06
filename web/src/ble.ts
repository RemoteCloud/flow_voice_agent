/**
 * Bluetooth push-to-talk buttons (Zello-type) that are not keyboards. They are reached directly over Bluetooth LE:
 * in a browser with Web Bluetooth (Chrome / Edge on Windows, macOS, Linux, ChromeOS), in the Android agent by the
 * app itself (`BleButton.kt`, same contract through `window.FlowVoiceAndroid.connectButtonSlot`).
 *
 * Up to three buttons, each in its own slot (1–3): buttons of the same make send the same bytes, so the slot is
 * what tells them apart. Nothing is known about a button beforehand, so every characteristic that can notify is
 * listened to and each distinct payload is a "key" (`bleKeyName`): "Ble1FFE101" goes down when the button in
 * slot 1 sends 01 on FFE1 and up when that characteristic sends anything else. Admin learns the key by a press,
 * exactly like a keyboard-type button.
 *
 * A browser asks the user to pick the device once per page load (the chooser needs a click); after that the
 * connection is kept and re-made by itself when the button sleeps and wakes.
 */
import { useSyncExternalStore } from "react";
import { BLE_BUTTON_SLOTS, bleIsRelease, bleKeyName } from "../../server/protocol.js";

// the part of Web Bluetooth used here (not in TypeScript's DOM lib)
interface BtCharacteristic extends EventTarget {
	uuid: string;
	value?: DataView;
	properties: { notify: boolean; indicate: boolean };
	startNotifications(): Promise<unknown>;
}
interface BtService {
	getCharacteristics(): Promise<BtCharacteristic[]>;
}
interface BtDevice extends EventTarget {
	name?: string;
	gatt?: { connected: boolean; connect(): Promise<{ getPrimaryServices(): Promise<BtService[]> }>; disconnect(): void };
}
type BtFilter = { services: (number | string)[] } | { namePrefix: string };
interface Bt {
	requestDevice(o: ({ acceptAllDevices: true } | { filters: BtFilter[] }) & { optionalServices: (number | string)[] }): Promise<BtDevice>;
}
const bt = (): Bt | undefined => (typeof navigator === "undefined" ? undefined : (navigator as unknown as { bluetooth?: Bt }).bluetooth);

/**
 * A page may only open the services it names up front. These are the ones push-to-talk buttons are built on:
 * the serial-style services of the common Bluetooth LE modules (FFE0, FFF0 …), Nordic UART and Microchip's.
 * A button on another service: add `?bleservice=<uuid>` once on that computer (remembered).
 */
const SERVICES: (number | string)[] = [0xffe0, 0xfff0, 0xff00, 0xff10, 0xffa0, 0xffb0, 0xffc0, 0xffd0, 0xfee0, "6e400001-b5a3-f393-e0a9-e50e24dcca9e", "49535343-fe7d-4ae5-8fa9-9fafd205e455"];
function services(): (number | string)[] {
	try {
		const q = new URLSearchParams(location.search).get("bleservice");
		if (q) localStorage.setItem("fv.bleService", q);
		const extra = (localStorage.getItem("fv.bleService") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
		return [...SERVICES, ...extra.map((s) => (/^[0-9a-f]{4}$/.test(s) ? parseInt(s, 16) : s))];
	} catch {
		return SERVICES;
	}
}

/**
 * The short list: only devices that look like a button, so it is not buried under every headset, watch and TV in
 * reach. A device counts when it advertises one of the button services or its name starts like a push-to-talk /
 * remote button (the chooser matches name beginnings only, as written). "Show all devices" drops the filter.
 */
const NAME_STARTS = ["PTT", "Ptt", "ptt", "BT-PTT", "BLE-PTT", "BLE PTT", "BT PTT", "APTT", "Blu-PTT", "BluPTT", "Zello", "ZELLO", "Pryme", "PRYME", "AINA", "Inrico", "Anysecu", "SHP", "Seecode", "Dellking", "R1", "Button", "BUTTON", "BTN", "Remote", "Selfie", "AB Shutter", "iTAG", "iTag", "ITAG", "Key", "Smart", "HM", "JDY", "BT05", "MLT-BT05", "CC41", "DSD", "Flic"];
const buttonFilters = (svc: (number | string)[]): BtFilter[] => [...svc.map((s) => ({ services: [s] })), ...NAME_STARTS.map((namePrefix) => ({ namePrefix }))];

export interface BleSlotState {
	name?: string;
	connected: boolean;
}
export interface BleButtonState {
	/** This device can reach a Bluetooth button at all. */
	supported: boolean;
	/** Slots 1–3, index 0 = slot 1. */
	slots: BleSlotState[];
	/** The slot being connected right now. */
	busy?: number;
	error?: string;
}

const emptySlots = (): BleSlotState[] => Array.from({ length: BLE_BUTTON_SLOTS }, () => ({ connected: false }));
let state: BleButtonState = { supported: false, slots: emptySlots() };
const watchers = new Set<() => void>();
const keyListeners = new Set<(key: string, down: boolean) => void>();
const set = (patch: Partial<BleButtonState>) => {
	state = { ...state, ...patch };
	for (const w of watchers) w();
};
const setSlot = (slot: number, patch: Partial<BleSlotState>, more: Partial<BleButtonState> = {}) => set({ ...more, slots: state.slots.map((s, i) => (i === slot - 1 ? { ...s, ...patch } : s)) });
const emit = (key: string, down: boolean) => {
	for (const l of keyListeners) l(key, down);
};

/** What sits in a slot of this page: the device and, per characteristic, the key that is down on it. */
interface Link {
	device: BtDevice;
	held: Map<string, string>;
}
const links = new Map<number, Link>();

function onValue(slot: number, link: Link, uuid: string, value: DataView | undefined): void {
	const bytes = value ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array();
	const key = bleKeyName(slot, uuid, bytes);
	const was = link.held.get(uuid);
	// anything new on the characteristic ends the press before it; the same payload again is a new press (click-only buttons)
	if (was) emit(was, false);
	// only zeros = let go: it ends the press and is no key of its own
	if (bleIsRelease(bytes)) {
		link.held.delete(uuid);
		return;
	}
	link.held.set(uuid, key);
	emit(key, true);
}

function releaseAll(link: Link): void {
	for (const k of link.held.values()) emit(k, false);
	link.held.clear();
}

async function open(slot: number, link: Link): Promise<void> {
	const server = await link.device.gatt!.connect();
	let n = 0;
	for (const s of await server.getPrimaryServices()) {
		for (const c of await s.getCharacteristics().catch(() => [] as BtCharacteristic[])) {
			if (!c.properties.notify && !c.properties.indicate) continue;
			c.addEventListener("characteristicvaluechanged", () => {
				if (links.get(slot) === link) onValue(slot, link, c.uuid, c.value);
			});
			await c.startNotifications().then(
				() => n++,
				() => undefined,
			);
		}
	}
	if (!n) throw new Error("This Bluetooth device reports no button presses the browser can read. If it shows up as a keyboard, pair it in the computer's Bluetooth settings instead.");
}

async function reconnect(slot: number, link: Link, attempt = 0): Promise<void> {
	if (links.get(slot) !== link) return;
	try {
		await open(slot, link);
		setSlot(slot, { connected: true }, { error: undefined });
	} catch {
		// the button sleeps or is out of reach: keep trying, slower each time
		window.setTimeout(() => void reconnect(slot, link, attempt + 1), Math.min(30000, 2000 * (attempt + 1)));
	}
}

/**
 * Pick the button for a slot (browser chooser / Android chooser) and connect. Call from a click.
 * `all` = list every Bluetooth device in reach instead of only the ones that look like a button.
 */
export async function connectBleButton(slot: number, all = false): Promise<void> {
	const android = window.FlowVoiceAndroid;
	if (android?.connectButtonSlot) {
		android.connectButtonSlot(slot, all);
		return;
	}
	const b = bt();
	if (!b) return;
	set({ busy: slot, error: undefined });
	try {
		const svc = services();
		const d = await b.requestDevice(all ? { acceptAllDevices: true, optionalServices: svc } : { filters: buttonFilters(svc), optionalServices: svc });
		for (const [other, l] of links) {
			if (other !== slot && l.device === d) throw new Error(`That button is already button ${other}.`);
		}
		const old = links.get(slot);
		const link: Link = { device: d, held: new Map() };
		links.set(slot, link);
		if (old) {
			releaseAll(old);
			if (old.device !== d) old.device.gatt?.disconnect();
		}
		d.addEventListener("gattserverdisconnected", () => {
			if (links.get(slot) !== link) return;
			releaseAll(link);
			setSlot(slot, { connected: false });
			void reconnect(slot, link);
		});
		await open(slot, link);
		setSlot(slot, { name: d.name || "Bluetooth button", connected: true }, { busy: undefined });
	} catch (e) {
		// closing the chooser without picking is not an error worth showing
		const cancelled = e instanceof DOMException && e.name === "NotFoundError";
		setSlot(slot, { connected: !!links.get(slot)?.device.gatt?.connected }, { busy: undefined, error: cancelled ? undefined : e instanceof Error ? e.message : String(e) });
	}
}

/** Presses of the connected Bluetooth buttons (and, in the Android app, of the hardware keys it catches), by key name. Returns the unsubscribe. */
export function onBleKey(listener: (key: string, down: boolean) => void): () => void {
	keyListeners.add(listener);
	return () => keyListeners.delete(listener);
}

function fromApp(json: string | undefined): BleSlotState[] {
	const slots = emptySlots();
	try {
		for (const s of JSON.parse(json ?? "[]") as { slot?: number; name?: string; connected?: boolean }[]) {
			if (s.slot && slots[s.slot - 1]) slots[s.slot - 1] = { name: s.name || undefined, connected: !!s.connected };
		}
	} catch {
		// an older app: no state yet
	}
	return slots;
}

function init(): void {
	if (typeof window === "undefined") return;
	const android = window.FlowVoiceAndroid;
	// the Android app reports its Bluetooth buttons, and the hardware keys it catches before the page, through here
	window.flowVoiceButton = emit;
	state = { ...state, supported: !!android?.connectButtonSlot || !!bt() };
	if (!android?.connectButtonSlot) return;
	// the app keeps its buttons across restarts and tells the page when they come and go
	window.flowVoiceButtonState = (json) => set({ slots: fromApp(json) });
	state = { ...state, slots: fromApp(android.buttonState?.()) };
}
init();

export function useBleButton(): BleButtonState {
	return useSyncExternalStore(
		(w) => {
			watchers.add(w);
			return () => watchers.delete(w);
		},
		() => state,
	);
}
