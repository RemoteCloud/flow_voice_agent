import { useEffect, useRef, useState } from "react";
import { BUTTON_ACTIONS, BUTTON_HOLD_MS, MAX_STATION_BUTTONS, bleKeySlot, buttonKeyName, type ButtonAction, type StationButton } from "../../../server/protocol.js";
import { onBleKey, useBleButton } from "../ble.js";
import { BUTTON_ACTION_TEXT, COMMON_BUTTON_KEYS, buttonKeyText, buttonPanelOpen, setButtonLearning } from "../buttons.js";
import { BleButtonLink } from "./BleButtonLink.js";
import { plural } from "./ui.js";

/**
 * Per station: up to three hardware buttons (Bluetooth or USB). A button shows up as a keyboard key on the computer
 * or tablet it is paired with, so setting one up is: press it once here (or pick its key), then say what it does.
 */
export function ButtonRules({ buttons, canEdit, onChange, device = false }: { buttons: StationButton[] | undefined; canEdit: boolean; onChange: (b: StationButton[] | undefined) => void; /** Shown on the device itself (Home → Buttons) instead of in Admin. */ device?: boolean }) {
	const list = buttons ?? [];
	const [learning, setLearning] = useState<number | undefined>();
	// On the device (Home → Buttons) only the buttons that are added to this device: a Bluetooth button whose slot has
	// nothing paired here belongs to another tablet. Keyboard-type keys and rows still waiting for a press always show.
	const ble = useBleButton();
	const [showAll, setShowAll] = useState(false);
	const here = (b: StationButton) => {
		const slot = b.key ? bleKeySlot(b.key) : undefined;
		const s = slot ? ble.slots[slot - 1] : undefined;
		return !device || showAll || !slot || !!s?.name || !!s?.connected;
	};
	const elsewhere = list.filter((b) => !here(b)).length;
	const put = (next: StationButton[]) => onChange(next.length ? next : undefined);
	const set = (i: number, patch: Partial<StationButton>) =>
		put(
			list.map((b, k) => {
				if (k !== i) return b;
				const { double, hold, ...rest } = { ...b, ...patch };
				// hold to talk takes the whole press: such a button does nothing else
				return rest.action === "talk" ? rest : { ...rest, ...(double && { double }), ...(hold && { hold }) };
			}),
		);
	// A connected push-to-talk button pressed while a row still has no key: that row takes it, no "Press the button" needed
	const fill = useRef<(key: string) => void>(() => {});
	fill.current = (key) => {
		if (!canEdit || learning !== undefined || list.some((b) => b.key === key)) return;
		const i = list.findIndex((b) => !b.key);
		if (i >= 0) set(i, { key });
	};
	useEffect(() => buttonPanelOpen(), []);
	// Show what is being pressed: the row of that button lights up, and a line names the key (also one no row has yet)
	const [pressed, setPressed] = useState<string[]>([]);
	const [last, setLast] = useState<string | undefined>();
	const bound = useRef<string[]>([]);
	bound.current = list.map((b) => b.key).filter(Boolean);
	useEffect(() => {
		const timers = new Map<string, number>();
		const press = (key: string, down: boolean) => {
			window.clearTimeout(timers.get(key));
			if (down) {
				setLast(key);
				setPressed((p) => (p.includes(key) ? p : [...p, key]));
				// a button that never says it was let go still goes dark
				timers.set(key, window.setTimeout(() => press(key, false), 3000));
			}
			// a click is over in a blink: keep it lit long enough to be seen
			else timers.set(key, window.setTimeout(() => setPressed((p) => p.filter((k) => k !== key)), 350));
		};
		const offBle = onBleKey((key, down) => {
			press(key, down);
			if (down) fill.current(key);
		});
		// keyboard-type buttons: only keys a row has, so typing never flashes anything
		const onKey = (e: KeyboardEvent) => {
			const key = buttonKeyName(e.code, e.key);
			if (key && bound.current.includes(key) && !e.repeat) press(key, e.type === "keydown");
		};
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("keyup", onKey, true);
		return () => {
			offBle();
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("keyup", onKey, true);
			for (const t of timers.values()) window.clearTimeout(t);
		};
	}, []);
	const lastRow = last ? list.findIndex((b) => b.key === last) : -1;
	// "Press the button": the next key that arrives is the button's key
	useEffect(() => {
		if (learning === undefined) return;
		// while a button is being learned its press belongs to this screen: no action runs, and the Android app hands every key over
		setButtonLearning(true);
		let taken = false;
		const take = (key: string) => {
			// one press, one key: whatever arrives before the screen has caught up is not a second answer
			if (taken) return;
			taken = true;
			setLearning(undefined);
			// a key does one thing: taking it for this button frees it from another one
			put(list.map((b, k) => (k === learning ? { ...b, key } : b.key === key ? { ...b, key: "" } : b)));
		};
		const onKey = (e: KeyboardEvent) => {
			const key = buttonKeyName(e.code, e.key);
			if (!key) return;
			e.preventDefault();
			e.stopPropagation();
			take(key);
		};
		window.addEventListener("keydown", onKey, true);
		// a push-to-talk button connected over Bluetooth (below) reports its press the same way
		const offBle = onBleKey((key, down) => {
			if (down) take(key);
		});
		return () => {
			window.removeEventListener("keydown", onKey, true);
			offBle();
			setButtonLearning(false);
		};
	});
	return (
		<div className="rounded-lg border border-line">
			<div className="flex flex-wrap items-center gap-2 px-3 py-2">
				<div className="min-w-0 flex-1 basis-60">
					<h3 className="text-sm font-medium">Buttons</h3>
					<p className="text-xs text-fg-muted">
						{device
							? "A Bluetooth or USB button for answering without the screen. Connect it below, press “Add a button”, press the button itself, then choose what it does."
							: "A Bluetooth or USB button for answering without the screen. A push-to-talk button (the kind used with Zello): press \"Connect button 1\" and pick it (a second and third one go in 2 and 3). A button that works as a keyboard: pair it in the computer's Bluetooth settings. Then add a button and press it. The same can be done on the tablet or phone itself: Buttons on its start screen."}
					</p>
				</div>
				<BleButtonLink always />
				{list.length < MAX_STATION_BUTTONS && (
					<button
						type="button"
						className="btn btn-sm"
						disabled={!canEdit}
						onClick={() => {
							const action = BUTTON_ACTIONS.find((a) => !list.some((b) => b.action === a)) ?? "accept";
							put([...list, { key: "", action }]);
							setLearning(list.length);
						}}
					>
						Add a button
					</button>
				)}
			</div>
			<p className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs" aria-live="polite">
				<span className={`inline-block size-3 shrink-0 rounded-full border border-line ${pressed.length ? "border-ok bg-ok" : ""}`} aria-hidden />
				{last ? (
					<span className={pressed.length ? "font-medium text-ok" : "text-fg-muted"}>
						{pressed.length ? "Pressed now" : "Last pressed"}: {buttonKeyText(last)}
						{lastRow >= 0 ? ` → button ${lastRow + 1}${list[lastRow]!.double || list[lastRow]!.hold ? "" : `, ${BUTTON_ACTION_TEXT[list[lastRow]!.action]}`}` : " (not set to anything yet)"}
					</span>
				) : (
					<span className="text-fg-muted">Press a button to see it react here.</span>
				)}
			</p>
			{list.some(here) && (
				<ul className="divide-y divide-line border-t border-line">
					{list.map((b, i) => !here(b) ? null : (
						<li key={i} className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm transition-colors ${b.key && pressed.includes(b.key) ? "bg-ok/25" : ""}`}>
							<span className={`w-16 shrink-0 ${b.key && pressed.includes(b.key) ? "font-medium text-ok" : "text-fg-muted"}`}>Button {i + 1}</span>
							<button type="button" className={`btn btn-sm ${learning === i ? "btn-primary" : ""}`} disabled={!canEdit} onClick={() => setLearning(learning === i ? undefined : i)} title="Press the button once so the hub knows which one it is">
								{learning === i ? "Press the button now…" : b.key ? `Key: ${buttonKeyText(b.key)}` : "Press the button"}
							</button>
							<select className="input w-auto py-1 text-xs" value={b.key} disabled={!canEdit} aria-label={`Key of button ${i + 1}`} onChange={(e) => put(list.map((x, k) => (k === i ? { ...x, key: e.target.value } : x.key === e.target.value ? { ...x, key: "" } : x)))}>
								<option value="">or pick its key…</option>
								{[...new Set([...(b.key ? [b.key] : []), ...COMMON_BUTTON_KEYS])].map((k) => (
									<option key={k} value={k}>
										{buttonKeyText(k)}
									</option>
								))}
							</select>
							<select className="input min-w-0 flex-1 basis-56 py-1 text-xs" value={b.action} disabled={!canEdit} aria-label={`What button ${i + 1} does`} onChange={(e) => set(i, { action: e.target.value as ButtonAction })}>
								{BUTTON_ACTIONS.map((a) => (
									<option key={a} value={a}>
										{b.action !== "talk" && (b.double || b.hold) ? "Press: " : ""}
										{BUTTON_ACTION_TEXT[a]}
									</option>
								))}
							</select>
							{b.action !== "talk" &&
								(["double", "hold"] as const).map((g) => (
									<select key={g} className="input min-w-0 flex-1 basis-56 py-1 text-xs" value={b[g] ?? ""} disabled={!canEdit} aria-label={`Button ${i + 1}, ${g === "double" ? "two quick presses" : "held down"}`} onChange={(e) => set(i, { [g]: (e.target.value || undefined) as ButtonAction | undefined })}>
										<option value="">{g === "double" ? "Two quick presses: nothing" : `Hold ${BUTTON_HOLD_MS / 1000} seconds: nothing`}</option>
										{BUTTON_ACTIONS.filter((a) => a !== "talk").map((a) => (
											<option key={a} value={a}>
												{g === "double" ? "Two quick presses: " : `Hold ${BUTTON_HOLD_MS / 1000} s: `}
												{BUTTON_ACTION_TEXT[a]}
											</option>
										))}
									</select>
								))}
							<button type="button" className="btn btn-sm btn-ghost" disabled={!canEdit} onClick={() => { setLearning(undefined); put(list.filter((_, k) => k !== i)); }}>
								Remove
							</button>
						</li>
					))}
				</ul>
			)}
			{(elsewhere > 0 || (device && showAll)) && (
				<p className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-xs text-fg-muted">
					{showAll ? "Showing the buttons of every device on this station." : `${plural(elsewhere, "more button")} on this station ${elsewhere === 1 ? "is a Bluetooth button" : "are Bluetooth buttons"} not added to this device.`}
					<button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAll(!showAll)}>
						{showAll ? "Only this device" : "Show all"}
					</button>
				</p>
			)}
			{list.length > 0 && !device && <p className="border-t border-line px-3 py-2 text-xs text-fg-muted">Works on computers and in the Android app. A push-to-talk button has to be connected on every device that uses it, under the same number as here: "Connect button 1" on the checklist screen (a computer asks each time the page is opened, the Android app remembers it). A button that sends a volume key only works on a tablet or phone. Devices that are already open pick the buttons up after a reload.</p>}
		</div>
	);
}

/**
 * The same on the device that uses the buttons (Home → Buttons): connect, press, choose. It saves to the station,
 * so every device on the station follows, and Admin shows what was set here.
 */
export function ButtonSetup({ stationId, buttons, onSave, onClose }: { stationId: string; buttons: StationButton[] | undefined; onSave: (stationId: string, buttons: StationButton[] | undefined) => Promise<void>; onClose: () => void }) {
	const [list, setList] = useState(buttons);
	const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
	const [err, setErr] = useState<string | undefined>();
	const change = (next: StationButton[] | undefined) => {
		setList(next);
		setState("saving");
		onSave(stationId, next).then(
			() => {
				setErr(undefined);
				setState("saved");
			},
			(e) => {
				setState("idle");
				setErr(e instanceof Error ? e.message : String(e));
			},
		);
	};
	return (
		<div className="fixed inset-0 z-20 flex items-end justify-center bg-black/60 p-3 sm:items-center" onClick={onClose}>
			<div className="card max-h-[90vh] w-full max-w-2xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
				<div className="card-head">
					<h3 className="card-title">Buttons on this station</h3>
					<span className={`ml-auto mr-2 text-xs ${state === "saved" ? "text-ok" : "text-fg-faint"}`} aria-live="polite">
						{state === "saving" ? "Saving…" : state === "saved" ? "Saved ✓" : ""}
					</span>
					<button type="button" className="btn btn-sm" onClick={onClose}>
						Done
					</button>
				</div>
				<div className="card-body space-y-3">
					<ButtonRules buttons={list} canEdit device onChange={change} />
					{err && <p className="text-sm text-danger">{err}</p>}
				</div>
			</div>
		</div>
	);
}
