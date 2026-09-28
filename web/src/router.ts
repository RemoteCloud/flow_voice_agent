/** Hash router: #/ (picker / phone home) · #/run/<id> · #/admin[/<tab>] · #/enroll · #/join/<token or six-digit code> (station QR / typed code, consumed on boot) */
import { useEffect, useState } from "react";

export type Route = { page: "picker" } | { page: "run"; id: string } | { page: "admin"; tab?: string } | { page: "enroll" } | { page: "join"; token: string };

export function parseRoute(hash: string): Route {
	// the direct admin link: /admin with no hash at all (an explicit "#/" is the checklist page)
	if (!hash && typeof location !== "undefined" && /^\/admin(\/|$)/.test(location.pathname)) return { page: "admin" };
	const h = hash.replace(/^#\/?/, "");
	const [page, id] = h.split("/");
	if (page === "run" && id) return { page: "run", id: decodeURIComponent(id) };
	if (page === "join" && id) return { page: "join", token: decodeURIComponent(id) };
	if (page === "admin") return id ? { page: "admin", tab: id } : { page: "admin" };
	if (page === "enroll") return { page: "enroll" };
	return { page: "picker" };
}

export function routeHash(r: Route): string {
	switch (r.page) {
		case "run":
			return `#/run/${encodeURIComponent(r.id)}`;
		case "join":
			return `#/join/${encodeURIComponent(r.token)}`;
		case "admin":
			return r.tab ? `#/admin/${r.tab}` : "#/admin";
		case "enroll":
			return "#/enroll";
		default:
			return "#/";
	}
}

export function navigate(r: Route): void {
	const h = routeHash(r);
	if (location.hash !== h) location.hash = h;
}

export function useRoute(): Route {
	const [route, setRoute] = useState(() => parseRoute(location.hash));
	useEffect(() => {
		const on = () => setRoute(parseRoute(location.hash));
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);
	return route;
}
