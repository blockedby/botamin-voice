import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import "./styles.css";

// The production CSP intentionally forbids eval. Configure Zod before loading
// App and its shared schemas so the optional JIT probe is never attempted.
z.config({ jitless: true });

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element is missing");

void import("./App").then(({ App }) => {
	createRoot(rootElement).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
});
