/** Version line for footers: hub build (from the session probe), this web bundle, and the Android app when inside it. */
export const WEB_BUILD: string = typeof __WEB_BUILD__ === "string" ? __WEB_BUILD__ : "dev";

export function versionLine(hubVersion?: string): string {
	const parts = [hubVersion ? `hub ${hubVersion}` : "", `web ${WEB_BUILD}`];
	try {
		const app = window.FlowVoiceAndroid?.version();
		if (app) parts.push(`app ${app}`);
	} catch {
		/* not inside the app */
	}
	return parts.filter(Boolean).join(" · ");
}
