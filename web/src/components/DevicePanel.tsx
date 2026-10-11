import { useState } from "react";
import type { StationView } from "../../../server/api.js";
import type { DeviceInfo, DeviceValue } from "../../../server/protocol.js";
import { deviceLabel } from "../../../server/protocol.js";

/** Topics first in this order, the rest alphabetically. */
const ORDER = ["device", "os", "app", "browser", "web", "screen", "memory", "storage", "cpu", "battery", "network", "bluetooth", "audio", "tts", "voices", "speech", "voice", "buttons", "input", "webview", "permissions", "management", "features", "hub"];
const TITLES: Record<string, string> = {
	device: "Device",
	os: "Operating system",
	app: "App",
	browser: "Browser",
	web: "Web bundle",
	screen: "Screen",
	memory: "Memory",
	storage: "Storage",
	cpu: "Processor",
	battery: "Battery & power",
	network: "Network",
	bluetooth: "Bluetooth",
	audio: "Audio",
	tts: "Voice (text to speech)",
	voices: "Voices",
	speech: "Speech recognition",
	voice: "Voice engine in use",
	buttons: "Buttons",
	input: "Input devices",
	webview: "WebView",
	permissions: "Permissions",
	management: "Management / kiosk",
	features: "Hardware features",
	hub: "Hub",
	osHints: "Operating system (client hints)",
	deviceHints: "Device (client hints)",
	browserHints: "Browser (client hints)",
};

/**
 * Admin → Stations: what the device on this station is. Live (connected now) when the endpoint sent it, else the
 * last one the hub kept. Collapsed to one line ("Samsung SM-T500 · Android 13, seen 2 min ago"); open = every
 * topic as a key / value table, with the raw JSON one click away for support tickets.
 */
export function DevicePanel({ station }: { station: StationView | undefined }) {
	const [open, setOpen] = useState(false);
	const [raw, setRaw] = useState(false);
	const [copied, setCopied] = useState(false);
	if (!station) return null;
	const live = station.endpoint?.device;
	const last = station.device;
	const info: DeviceInfo | undefined = live ?? last?.info;
	if (!info) return null;
	const label = live ? deviceLabel(live) : last?.label || deviceLabel(info);
	const when = live ? "connected now" : last ? `last seen ${ago(last.at)}` : "";
	const who = (live ? station.endpoint?.user : last?.user) ?? "";
	const json = JSON.stringify(info, null, 2);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(json);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		} catch {
			/* no clipboard */
		}
	};
	const topics = Object.keys(info).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
	return (
		<div className="rounded-lg border border-line sm:col-span-2">
			<button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
				<span className="text-fg-muted">Device:</span>
				<span className="min-w-0 flex-1 truncate">
					{label || "unknown device"}
					<span className="text-fg-faint">
						{" "}
						· {when}
						{who ? ` · ${who}` : ""}
					</span>
				</span>
				<span className="text-xs text-fg-faint">{open ? "Hide" : "Show"}</span>
			</button>
			{open && (
				<div className="border-t border-line p-3">
					<div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
						<button type="button" className="btn btn-sm btn-ghost" onClick={() => setRaw((r) => !r)}>
							{raw ? "As a table" : "As JSON"}
						</button>
						<button type="button" className="btn btn-sm btn-ghost" onClick={() => void copy()}>
							{copied ? "Copied ✓" : "Copy JSON"}
						</button>
						<span className="text-fg-faint">Sent by the device when it connects. No serial numbers, addresses or names of networks.</span>
					</div>
					{raw ? (
						<pre className="mono max-h-[32rem] overflow-auto whitespace-pre-wrap break-all rounded bg-panel-2 p-2 text-xs">{json}</pre>
					) : (
						<div className="grid gap-3 md:grid-cols-2">
							{topics.map((t) => (
								<section key={t} className="min-w-0">
									<h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">{TITLES[t] ?? t}</h4>
									<Rows value={info[t]} />
								</section>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function Rows({ value }: { value: DeviceValue }) {
	if (value === null || typeof value !== "object") return <p className="text-sm">{fmt(value)}</p>;
	if (Array.isArray(value)) return <p className="mono break-words text-xs">{value.map(fmt).join(", ") || "—"}</p>;
	const entries = Object.entries(value);
	if (!entries.length) return <p className="text-xs text-fg-faint">—</p>;
	return (
		<table className="w-full text-xs">
			<tbody>
				{entries.map(([k, v]) => (
					<tr key={k} className="align-top">
						<td className="whitespace-nowrap pr-3 text-fg-muted">{words(k)}</td>
						<td className="mono break-words">
							{v !== null && typeof v === "object" && !Array.isArray(v) ? (
								<Rows value={v} />
							) : Array.isArray(v) && v.some((x) => x !== null && typeof x === "object") ? (
								<ul className="space-y-1">
									{v.map((x, i) => (
										<li key={i}>
											<Rows value={x} />
										</li>
									))}
								</ul>
							) : (
								fmt(v)
							)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function fmt(v: DeviceValue): string {
	if (v === null) return "—";
	if (typeof v === "boolean") return v ? "yes" : "no";
	if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, "");
	if (typeof v === "string") return v === "" ? "—" : v;
	if (Array.isArray(v)) return v.map(fmt).join(", ") || "—";
	return JSON.stringify(v);
}

/** camelCase → "Camel case"; acronyms upper-cased, unit suffixes ("Mb", "Px", "Mbps") left as written. */
function words(k: string): string {
	return k
		.replace(/([a-z\d])([A-Z])/g, "$1 $2")
		.replace(/\b(Sdk|Abi|Abis|Mtu|Dns|Ip|Vid|Pid|Tts|Stt|Ble|Sco|Usb|Pip|Adb|Hdr|Gps|Nfc|Rssi|Rtt|Rx|Tx|Css|Dpi|Adb|Vpn|Ac|Hid)\b/g, (m) => m.toUpperCase())
		.replace(/^./, (m) => m.toUpperCase());
}

function rank(t: string): number {
	const i = ORDER.indexOf(t);
	return i < 0 ? ORDER.length : i;
}

function ago(iso: string): string {
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString();
	const min = Math.round(ms / 60000);
	if (min < 1) return "just now";
	if (min < 60) return `${min} min ago`;
	const h = Math.round(min / 60);
	if (h < 48) return `${h} h ago`;
	return new Date(iso).toLocaleDateString();
}
