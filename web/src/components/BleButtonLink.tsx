import { useState } from "react";
import { BLE_BUTTON_SLOTS, bleKeySlot, type StationButton } from "../../../server/protocol.js";
import { connectBleButton, useBleButton } from "../ble.js";

/**
 * "Connect button 1 / 2 / 3": shown on a station that uses Bluetooth push-to-talk buttons (ones that are not
 * keyboards), one control per button the station uses. A browser has to be shown each button once per page load;
 * the Android app remembers them. `always` shows all three without such a button on the station (Admin, where the
 * buttons are being set up). The list offered is short (devices that look like a button); "Show all devices"
 * makes the next pick list everything in reach.
 */
export function BleButtonLink({ buttons, always, quiet, className = "btn btn-sm" }: { buttons?: StationButton[]; always?: boolean; quiet?: boolean; className?: string }) {
	const b = useBleButton();
	const [all, setAll] = useState(false);
	const used = new Set((buttons ?? []).map((x) => bleKeySlot(x.key)).filter((n): n is number => !!n));
	const slots = Array.from({ length: BLE_BUTTON_SLOTS }, (_, i) => i + 1).filter((n) => always || used.has(n));
	if (!slots.length) return null;
	if (!b.supported) return always ? <span className="text-xs text-fg-muted">This browser cannot reach Bluetooth buttons. Use Chrome or Edge.</span> : null;
	if (quiet) {
		// run screen / voice bar: say nothing while every button is connected; warn only about a known button that is
		// out of reach (tap = try again). Setting buttons up lives in Home → Buttons and Admin.
		const away = slots.filter((n) => {
			const s = b.slots[n - 1];
			return b.busy === n || (s?.name && !s.connected);
		});
		if (!away.length && !b.error) return null;
		return (
			<span className="inline-flex max-w-full flex-wrap items-center gap-2">
				{away.map((n) => (
					<button key={n} type="button" className={`${className} border-warn/60 text-warn`} disabled={b.busy !== undefined} onClick={() => void connectBleButton(n, false)} title="This button is set up on this device but not in reach. Tap to look for it again.">
						{b.busy === n ? "Connecting…" : `Button ${n}: ${b.slots[n - 1]?.name} · not in reach`}
					</button>
				))}
				{b.error && <span className="text-xs text-danger">{b.error}</span>}
			</span>
		);
	}
	return (
		<span className="inline-flex max-w-full flex-wrap items-center gap-2">
			{slots.map((n) => {
				const s = b.slots[n - 1];
				return (
					<button key={n} type="button" className={className} disabled={b.busy !== undefined} onClick={() => void connectBleButton(n, all)} title={s?.name ? `Pick another Bluetooth button as button ${n}` : `Pick the Bluetooth button to use as button ${n} on this device`}>
						{b.busy === n ? "Connecting…" : s?.connected ? `Button ${n}: ${s.name ?? "connected"} ✓` : s?.name ? `Button ${n}: ${s.name} · not in reach` : `Connect button ${n}`}
					</button>
				);
			})}
			<label className="flex items-center gap-1.5 text-xs text-fg-muted" title="The list normally shows only devices that look like a button. Tick this when yours is not in it.">
				<input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
				Show all devices
			</label>
			{b.error && <span className="text-xs text-danger">{b.error}</span>}
		</span>
	);
}
