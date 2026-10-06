import { createContext, useContext } from "react";
import type { MeResponse, SessionProbeResponse, Station } from "../../server/api.js";
import type { StationButton } from "../../server/protocol.js";

export interface AppApi {
	me: MeResponse;
	boot: SessionProbeResponse;
	stations: Station[];
	refreshMe(): Promise<void>;
	signOut(): Promise<void>;
	setStation(stationId: string): Promise<void>;
	/** Save a station's hardware buttons from this device (Home → Buttons); every screen follows at once. */
	saveButtons(stationId: string, buttons: StationButton[] | undefined): Promise<void>;
}

export const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
	const v = useContext(AppContext);
	if (!v) throw new Error("useApp outside AppContext");
	return v;
}
