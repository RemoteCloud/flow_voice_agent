import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App.js";
import "./index.css";
import { applyTheme, readTheme } from "./theme.js";

applyTheme(readTheme());
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(readTheme()));

registerSW({ immediate: true });

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
