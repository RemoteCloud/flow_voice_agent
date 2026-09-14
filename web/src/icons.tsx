/**
 * A small hand-drawn stroke icon set (24×24, currentColor) — no icon library in the bundle.
 * `iconFor(name)` picks one for a checklist from keywords in its template name.
 */

export type IconName = "anchor" | "engine" | "fuel" | "fire" | "lifebuoy" | "compass" | "wrench" | "shield" | "drop" | "bell" | "power" | "clipboard" | "check" | "play" | "sun" | "moon" | "auto" | "qr" | "chevron";

const PATHS: Record<IconName, string> = {
	anchor: "M12 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 4v14M5 12H3a9 9 0 0 0 18 0h-2M8 21c2-1 3-2 4-4 1 2 2 3 4 4",
	engine: "M4 10h3l2-2h6l2 2h3v7h-3l-2 2H9l-2-2H4zM7 6V4h10v2M12 6v2M2 12v4M22 12v4",
	fuel: "M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M15 9h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V9l-3-3M8 7h4v4H8z",
	fire: "M12 3c1 3 4 5 4 9a4 4 0 0 1-8 0c0-1.5.5-2.5 1-3 0 1 .5 2 1.5 2C11 8 10 6 12 3ZM12 21a6 6 0 0 0 6-6c0-2-1-3.5-2-5",
	lifebuoy: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM5.6 5.6l3.6 3.6M18.4 5.6l-3.6 3.6M5.6 18.4l3.6-3.6M18.4 18.4l-3.6-3.6",
	compass: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm4-4-2.5 6.5L7 16l2.5-6.5L16 7Z",
	wrench: "M14 6a4 4 0 0 0 5.5 3.7L9.7 19.5a2 2 0 0 1-2.8-2.8l9.8-9.8A4 4 0 0 0 14 6Z",
	shield: "M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3Zm-3 9 2 2 4-4",
	drop: "M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Zm-3 12a3 3 0 0 0 3 3",
	bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Zm4 4a2 2 0 0 0 4 0",
	power: "M12 3v9M7 6.5a8 8 0 1 0 10 0",
	clipboard: "M9 4h6v3H9zM9 5H7a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2M9 12h6M9 16h4",
	check: "M5 12.5 9.5 17 19 7",
	play: "M8 5v14l11-7z",
	sun: "M12 4V2M12 22v-2M4.9 4.9 3.5 3.5M20.5 20.5l-1.4-1.4M2 12h2M20 12h2M4.9 19.1l-1.4 1.4M20.5 3.5l-1.4 1.4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z",
	moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z",
	auto: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0v18M12 3a9 9 0 0 1 0 18",
	qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM6.5 6.5h1v1h-1zM16.5 6.5h1v1h-1zM6.5 16.5h1v1h-1z",
	chevron: "M9 6l6 6-6 6",
};

export function Icon({ name, size = 24, className, strokeWidth = 1.75 }: { name: IconName; size?: number; className?: string; strokeWidth?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" focusable="false">
			<path d={PATHS[name]} />
		</svg>
	);
}

/** Ordered keyword table: the first matching row wins; unknown names get the clipboard. */
const KEYWORDS: [RegExp, IconName][] = [
	[/arriv|depart|pilot|berth|anchor|moor|port|harbou?r|unmoor/i, "anchor"],
	[/engine|machin|generator|aux|turbo|propul/i, "engine"],
	[/bunker|fuel|oil|lube|lubric/i, "fuel"],
	[/fire|hot ?work|weld/i, "fire"],
	[/abandon|muster|lifeboat|drill|rescue|man ?overboard|mob/i, "lifebuoy"],
	[/safety|ppe|permit|enclosed|confined|risk/i, "shield"],
	[/round|inspect|watch|patrol|walk/i, "compass"],
	[/mainten|repair|service|overhaul/i, "wrench"],
	[/ballast|bilge|tank|water|sound/i, "drop"],
	[/alarm|test|alert/i, "bell"],
	[/start|shut ?down|power|stop/i, "power"],
];

export function iconFor(name: string): IconName {
	for (const [re, icon] of KEYWORDS) if (re.test(name)) return icon;
	return "clipboard";
}
