import { expect, test } from "./fixtures";

const status = (namespace: string, peer: string) => `[data-testid="status-${namespace}-${peer}"]`;
const poll = (namespace: string, peer: string) => `[data-testid="poll-${namespace}-${peer}"]`;

test("options page queries the background service worker", async ({ page, extensionId }) => {
	await page.goto(`chrome-extension://${extensionId}/options.html`);

	await expect(page.locator(status("options", "background"))).toContainText(
		"pong from background",
		{
			timeout: 15_000,
		},
	);
});

test("options page streams a subscription and reports unknown namespaces", async ({
	page,
	extensionId,
}) => {
	await page.goto(`chrome-extension://${extensionId}/options.html`);

	await expect(page.locator(poll("options", "background"))).toContainText("data 0", {
		timeout: 15_000,
	});
	await expect(page.locator(poll("options", "background"))).toContainText("data 1", {
		timeout: 15_000,
	});

	// a namespace whose context is not open surfaces as an error, not a hang
	await expect(page.locator(status("options", "devtools"))).toContainText("error", {
		timeout: 15_000,
	});
	await expect(page.locator(poll("options", "devtools"))).toContainText("error", {
		timeout: 15_000,
	});
});

test("popup pings the background and the options page", async ({ context, extensionId }) => {
	const optionsPage = await context.newPage();
	await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);

	const popupPage = await context.newPage();
	await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

	await expect(popupPage.locator(status("popup", "background"))).toContainText(
		"pong from background",
		{
			timeout: 15_000,
		},
	);
	await expect(popupPage.locator(status("popup", "options"))).toContainText("pong from options", {
		timeout: 15_000,
	});
});

test("content script talks to the background inside its tab", async ({ context }) => {
	const contentPage = await context.newPage();
	await contentPage.goto("https://example.com/");

	await expect(contentPage.locator(status("content", "background"))).toContainText(
		"pong from background",
		{ timeout: 15_000 },
	);
	// ctx carries the calling tab
	await expect(contentPage.locator(status("content", "background"))).toContainText("(tab:");
	await expect(contentPage.locator(poll("content", "background"))).toContainText("data 0", {
		timeout: 15_000,
	});
});
