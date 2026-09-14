import { useMemo } from "react";
import { encodeQr, qrPath, type EcLevel } from "../../../server/core/qr.js";

/** Black-on-white QR (fixed colours so it scans in dark mode too). Shows a short error when the text will not fit. */
export function QrCode({ text, size = 224, ec = "M", className }: { text: string; size?: number; ec?: EcLevel; className?: string }) {
	const m = useMemo(() => {
		try {
			return encodeQr(text, { ec });
		} catch (e) {
			return e instanceof RangeError ? undefined : (() => { throw e; })();
		}
	}, [text, ec]);
	if (!m) {
		return (
			<div className={`flex items-center justify-center rounded-xl border border-warn/50 bg-panel-2 p-3 text-center text-xs text-warn ${className ?? ""}`} style={{ width: size, height: size }}>
				URL too long for the QR code — shorten the base URL.
			</div>
		);
	}
	const units = m.size + 8;
	return (
		<svg viewBox={`0 0 ${units} ${units}`} width={size} height={size} shapeRendering="crispEdges" className={`rounded-xl ${className ?? ""}`} role="img" aria-label="QR code">
			<rect width={units} height={units} fill="#ffffff" />
			<path d={qrPath(m, 4)} fill="#000000" />
		</svg>
	);
}
