import { useEffect, useState, type ReactNode } from "react";
import type { TenantsResponse } from "../../../server/tenants.js";
import { api } from "../api.js";
import { Icon } from "../icons.js";
import { useDayNight, useTheme } from "../theme.js";
import { useApp } from "../context.js";
import { navigate, type Route } from "../router.js";

/**
 * App chrome. `mobile` (phones / the Android agent) gets a one-line bar: logo, "location · station",
 * theme, sign out — no Admin tab, no vessel/user detail. The browser gets the full header.
 */
export function Shell({ route, mobile = false, children }: { route: Route; mobile?: boolean; children: ReactNode }) {
	const { me, boot, stations, signOut } = useApp();
	const [theme, cycle] = useTheme();
	const [night, toggleNight] = useDayNight();
	// which tenant this browser is in (token tenants only; the main hub shows nothing extra)
	const [tenantName, setTenantName] = useState<string | undefined>();
	useEffect(() => {
		api.get<TenantsResponse>("tenants").then((t) => setTenantName(t.current?.name), () => undefined);
	}, []);
	const leaveTenant = async () => {
		await api.post("tenants/leave");
		location.assign("/admin");
	};
	// on a phone / tablet the station only counts once a QR poster set it
	const station = mobile && me.stationSource !== "join" ? undefined : stations.find((s) => s.stationId === me.stationId);
	const stationLabel = station ? (station.location ? `${station.location} · ${station.name}` : station.name) : "No station";
	const themeIcon = theme === "dark" ? "moon" : theme === "light" ? "sun" : "auto";
	const themeTitle = theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Auto (follows the device)";
	const tab = (r: Route, label: string, active: boolean) => (
		<button type="button" onClick={() => navigate(r)} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${active ? "bg-panel-2 text-fg" : "text-fg-muted hover:text-fg"}`}>
			{label}
		</button>
	);

	if (mobile) {
		return (
			<div className="flex min-h-screen flex-col">
				<header className="sticky top-0 z-10 border-b border-line bg-bg/95 backdrop-blur">
					<div className="flex items-center gap-2 px-3 py-2">
						<button type="button" className="flex items-center gap-2" onClick={() => navigate({ page: "picker" })} aria-label="Checklists">
							<img src="/icon.svg" width={24} height={24} alt="" />
						</button>
						<span className="pill min-w-0 truncate border-line-strong text-fg-muted" title="Station">
							{tenantName ? `${tenantName} · ` : ""}
							{stationLabel}
						</span>
						<button type="button" className="btn ml-auto h-11 shrink-0 gap-2 px-4 text-sm font-semibold tracking-wide uppercase" onClick={toggleNight} aria-pressed={night} aria-label={night ? "Night mode on. Switch to day" : "Day mode on. Switch to night"}>
							<Icon name={night ? "moon" : "sun"} size={20} />
							{night ? "Night" : "Day"}
						</button>
						<button type="button" className="btn btn-sm btn-ghost" onClick={() => void signOut()}>
							Sign out
						</button>
					</div>
				</header>
				<main className="w-full flex-1 px-3 py-3">{children}</main>
			</div>
		);
	}

	return (
		<div className="flex min-h-screen flex-col">
			<header className="sticky top-0 z-10 border-b border-line bg-bg/95 backdrop-blur">
				<div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
					<button type="button" className="flex items-center gap-2" onClick={() => navigate({ page: "picker" })}>
						<img src="/icon.svg" width={26} height={26} alt="" />
						<span className="font-semibold tracking-tight">Flow Voice</span>
					</button>
					<span className="hidden text-xs text-fg-faint sm:inline">{boot.vesselId}</span>
					{tenantName && (
						<button type="button" className="pill shrink-0 border-warn/60 whitespace-nowrap text-warn" onClick={() => void leaveTenant()} title="Back to the main hub">
							Tenant: {tenantName} · leave
						</button>
					)}
					<nav className="ml-2 flex items-center gap-1">
						{tab({ page: "picker" }, "Checklists", route.page === "picker" || route.page === "run")}
						{tab({ page: "admin" }, "Admin", route.page === "admin")}
					</nav>
					<div className="ml-auto flex items-center gap-3 text-sm">
						<span className="pill border-line-strong text-fg-muted" title="Station">
							{stationLabel}
						</span>
						<span className="hidden text-fg-muted sm:inline">{me.name ?? me.sub}</span>
						<button type="button" className="btn btn-sm btn-ghost" onClick={cycle} title={`Theme: ${themeTitle}`} aria-label="Switch theme">
							<Icon name={themeIcon} size={16} />
							{theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Auto"}
						</button>
						<button type="button" className="btn btn-sm" onClick={() => void signOut()}>
							Sign out
						</button>
					</div>
				</div>
			</header>
			<main className="mx-auto w-full max-w-5xl flex-1 px-4 py-4">{children}</main>
		</div>
	);
}
