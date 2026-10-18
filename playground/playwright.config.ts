import { defineConfig } from "@playwright/test";

const ci = !!process.env["CI"];

export default defineConfig({
	testDir: "e2e",
	forbidOnly: ci,
	retries: ci ? 2 : 0,
	workers: ci ? 1 : undefined,
	reporter: ci ? "github" : "list",
	use: {
		trace: "on-first-retry",
	},
	timeout: 30_000,
	projects: [
		{
			name: "chromium",
			use: { browserName: "chromium" },
		},
	],
});
