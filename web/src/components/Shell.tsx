import { useState, type ReactNode } from "react";
import { readTheme, saveTheme, type Theme } from "../theme.js";
import { useApp } from "../context.js";
import { navigate, type Route } from "../router.js";

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
	const { me, boot, stations, signOut } = useApp();
	const [theme, setTheme] = useState<Theme>(readTheme);
	const cycle = () => {
		const next: Theme = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
		setTheme(next);
		saveTheme(next);
	};
	const station = stations.find((s) => s.stationId === me.stationId);
	const tab = (r: Route, label: string, active: boolean) => (
		<button type="button" onClick={() => navigate(r)} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${active ? "bg-panel-2 text-fg" : "text-fg-muted hover:text-fg"}`}>
			{label}
		</button>
	);
	return (
		<div className="flex min-h-screen flex-col">
			<header className="sticky top-0 z-10 border-b border-line bg-bg/95 backdrop-blur">
				<div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
					<button type="button" className="flex items-center gap-2" onClick={() => navigate({ page: "picker" })}>
						<img src="/icon.svg" width={26} height={26} alt="" />
						<span className="font-semibold tracking-tight">Flow Voice</span>
					</button>
					<span className="hidden text-xs text-fg-faint sm:inline">{boot.vesselId}</span>
					<nav className="ml-2 flex items-center gap-1">
						{tab({ page: "picker" }, "Checklists", route.page === "picker" || route.page === "run")}
						{tab({ page: "admin" }, "Admin", route.page === "admin")}
					</nav>
					<div className="ml-auto flex items-center gap-3 text-sm">
						<span className="pill border-line-strong text-fg-muted" title="Station">
							{station ? station.name : "No station"}
						</span>
						<span className="hidden text-fg-muted sm:inline">{me.name ?? me.sub}</span>
						<button type="button" className="btn btn-sm btn-ghost" onClick={cycle} title="Theme: light / dark / follow the device" aria-label="Switch theme">
							{theme === "dark" ? "🌙 Dark" : theme === "light" ? "☀️ Light" : "◐ Auto"}
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
