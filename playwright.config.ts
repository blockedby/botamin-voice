import { defineConfig, devices } from "@playwright/test";

const previewOrigin = "http://127.0.0.1:4174";

export default defineConfig({
	testDir: "./tests/browser",
	testMatch: "**/*.pw.ts",
	outputDir: ".runtime/playwright/test-results",
	fullyParallel: true,
	forbidOnly: true,
	retries: 0,
	workers: 1,
	reporter: "line",
	use: {
		baseURL: previewOrigin,
		bypassCSP: false,
		headless: true,
		serviceWorkers: "block",
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium-desktop",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1280, height: 720 },
			},
		},
		{
			name: "chromium-mobile",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 390, height: 844 },
			},
		},
		{
			name: "webkit-desktop",
			use: {
				...devices["Desktop Safari"],
				viewport: { width: 1280, height: 720 },
			},
		},
	],
	webServer: {
		command:
			"bun run --filter @botamin/web build && bun run --filter @botamin/web preview --host 127.0.0.1 --port 4174 --strictPort",
		url: `${previewOrigin}/`,
		cwd: process.cwd(),
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
