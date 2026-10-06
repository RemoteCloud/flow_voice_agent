import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { buildStamp } from "../scripts/lib/build-stamp.mjs";

// Built into ../dist/public and served by the hub from the same origin as the API (spec 14.2).
export default defineConfig({
	root: __dirname,
	define: { __WEB_BUILD__: JSON.stringify(buildStamp()) },
	plugins: [
		react(),
		tailwindcss(),
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: ["icon.svg", "mark.svg", "mark-on-dark.svg", "logo.svg", "logo-on-dark.svg"],
			manifest: {
				name: "Flow Voice by Maranics",
				short_name: "Flow Voice by Maranics",
				description: "Run Maranics Flow checklists by voice",
				theme_color: "#f6f7f8",
				background_color: "#f6f7f8",
				display: "standalone",
				orientation: "portrait",
				start_url: "/",
				icons: [
					{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
					{ src: "icon-192.png", sizes: "192x192", type: "image/png" },
					{ src: "icon-512.png", sizes: "512x512", type: "image/png" },
				],
			},
			workbox: {
				// the app shell is cached; API and sockets always go to the hub on the ship LAN
				navigateFallback: "/index.html",
				navigateFallbackDenylist: [/^\/api\//, /^\/t\//, /^\/v1\//, /^\/healthz/, /^\/metrics/],
				runtimeCaching: [],
			},
		}),
	],
	build: { outDir: "../dist/public", emptyOutDir: true, sourcemap: false },
	server: {
		port: 5173,
		proxy: {
			"/api": { target: "http://127.0.0.1:8443", changeOrigin: false },
			"/v1": { target: "http://127.0.0.1:8443", ws: true, changeOrigin: false },
		},
	},
});
