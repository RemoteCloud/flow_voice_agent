/**
 * The station's Maranics Flow app (`Station.flowUrl`, Admin → Stations): the Android agent keeps it in a second
 * WebView next to the voice client (loaded as soon as the device has joined the station, shown with "Flow"); a
 * browser opens it in a new tab.
 */
import { useEffect } from "react";

/** Tell the Android agent which Flow app belongs to the station this device is on ("" = none). */
export function useFlowApp(flowUrl: string | undefined): void {
	useEffect(() => {
		window.FlowVoiceAndroid?.setFlowUrl?.(flowUrl ?? "");
	}, [flowUrl]);
}

export function openFlowApp(flowUrl: string): void {
	const android = window.FlowVoiceAndroid;
	if (android?.showFlow) android.showFlow(true);
	else window.open(flowUrl, "_blank", "noopener");
}
