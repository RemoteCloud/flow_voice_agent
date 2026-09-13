import { useEffect, useState } from "react";
import type { EnrollPollResponse, EnrollResponse } from "../../../server/api.js";
import { api, toApiError } from "../api.js";
import { navigate } from "../router.js";

/** One-time device enrollment: the device asks, an admin approves the 6-digit code in Admin → Devices. */
export function EnrollPage() {
	const [name, setName] = useState(() => localStorage.getItem("fv.deviceName") ?? "");
	const [code, setCode] = useState<string | undefined>();
	const [state, setState] = useState<"idle" | "pending" | "approved">("idle");
	const [err, setErr] = useState<string | undefined>();

	const request = async () => {
		setErr(undefined);
		try {
			const res = await api.post<EnrollResponse>("devices/enroll", { deviceName: name || "device", kind: window.FlowVoiceAndroid ? "android" : "pwa" });
			localStorage.setItem("fv.deviceName", name);
			setCode(res.code);
			setState("pending");
		} catch (e) {
			setErr(toApiError(e).message);
		}
	};

	useEffect(() => {
		if (state !== "pending" || !code) return;
		const t = window.setInterval(async () => {
			try {
				const r = await api.get<EnrollPollResponse>(`devices/enroll/${code}`);
				if (r.state === "approved") {
					if (r.token) localStorage.setItem("fv.deviceToken", r.token);
					if (r.deviceId) localStorage.setItem("fv.deviceId", r.deviceId);
					setState("approved");
				} else if (r.state === "unknown") {
					setErr("The code expired. Request a new one.");
					setState("idle");
				}
			} catch {
				/* keep polling */
			}
		}, 3000);
		return () => window.clearInterval(t);
	}, [state, code]);

	return (
		<main className="flex min-h-screen items-center justify-center px-4 py-10">
			<div className="card w-full max-w-md">
				<div className="card-head">
					<h1 className="card-title">Enroll this device</h1>
					<button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate({ page: "picker" })}>
						Back
					</button>
				</div>
				<div className="card-body space-y-4">
					{state === "idle" && (
						<>
							<p className="text-sm text-fg-muted">Enrollment happens once per device. An administrator approves the code in the hub's Admin screen.</p>
							<label className="label" htmlFor="dn">
								Device name
							</label>
							<input id="dn" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Bridge tablet" />
							<button type="button" className="btn btn-primary w-full" onClick={() => void request()}>
								Request enrollment
							</button>
						</>
					)}
					{state === "pending" && (
						<div className="text-center">
							<p className="text-sm text-fg-muted">Tell the administrator this pairing code:</p>
							<p className="my-3 font-mono text-4xl tracking-[0.3em]">{code}</p>
							<p className="help">Waiting for approval…</p>
						</div>
					)}
					{state === "approved" && (
						<div className="text-center">
							<p className="text-ok">Device enrolled.</p>
							<button type="button" className="btn btn-primary mt-3" onClick={() => navigate({ page: "picker" })}>
								Continue to sign-in
							</button>
						</div>
					)}
					{err && <p className="text-sm text-danger">{err}</p>}
				</div>
			</div>
		</main>
	);
}
