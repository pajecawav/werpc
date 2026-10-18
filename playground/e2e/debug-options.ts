import path from "node:path";
import { chromium } from "@playwright/test";

const pathToExtension = path.resolve("dist");

const run = async () => {
	const context = await chromium.launchPersistentContext("", {
		headless: false,
		args: [
			`--disable-extensions-except=${pathToExtension}`,
			`--load-extension=${pathToExtension}`,
		],
	});

	let [worker] = context.serviceWorkers();
	if (!worker) {
		worker = await context.waitForEvent("serviceworker");
	}
	worker.on("console", msg => console.log("[SW]", msg.text()));

	const page = await context.newPage();
	page.on("console", msg => console.log("[PAGE]", msg.type(), msg.text()));
	page.on("pageerror", err => console.log("[PAGEERROR]", err.message));

	await page.goto(`chrome-extension://${worker.url().split("/")[2]}/options.html`);
	await page.waitForTimeout(8000);

	const statuses = await page.locator("[data-testid^=status-]").allTextContents();
	const polls = await page.locator("[data-testid^=poll-]").allTextContents();
	console.log("STATUSES:", JSON.stringify(statuses, null, 1));
	console.log("POLLS:", JSON.stringify(polls, null, 1));

	await context.close();
};

void run();
