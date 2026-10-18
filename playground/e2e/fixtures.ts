import path from "node:path";
import { test as base, chromium, type BrowserContext } from "@playwright/test";

const pathToExtension = path.resolve("dist");
const headless = process.env["PW_HEADLESS"] === "1";

export const test = base.extend<{
	context: BrowserContext;
	extensionId: string;
}>({
	// eslint-disable-next-line eslint/no-empty-pattern
	context: async ({}, use) => {
		const context = await chromium.launchPersistentContext("", {
			headless,
			// the old headless shell does not support extensions; new headless does
			channel: headless ? "chromium" : undefined,
			args: [
				`--disable-extensions-except=${pathToExtension}`,
				`--load-extension=${pathToExtension}`,
			],
		});
		await use(context);
		await context.close();
	},
	extensionId: async ({ context }, use) => {
		let [background] = context.serviceWorkers();
		if (!background) {
			background = await context.waitForEvent("serviceworker");
		}
		const extensionId = background.url().split("/")[2]!;
		await use(extensionId);
	},
});

export const expect = test.expect;
