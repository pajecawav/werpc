import { TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createClient, createHandler, initWERPC } from "../src/index.ts";
import { router } from "../src/router.ts";
import { FakeExtension, sleep, withTimeout } from "./harness/hub.ts";
import { inContext, swMode } from "./harness/werpc.ts";

beforeEach(() => {
	router.reset();
});

const ns = <R extends AnyRouter>(client: unknown, name: string): TRPCClient<R> => {
	const value = (client as Record<string, TRPCClient<R>>)[name];
	if (!value) {
		throw new Error(`namespace ${name} not found on client`);
	}
	return value;
};

const setup = () => {
	const ext = new FakeExtension();

	const bgT = initWERPC();
	const bgRouter = bgT.router({
		ping: bgT.procedure.query(() => "pong"),
	});
	const otherT = initWERPC();
	const otherSwRouter = otherT.router({
		ping: otherT.procedure.query(() => "second sw handler"),
	});

	inContext(ext, "bg", "sw", undefined, () => {
		swMode(() => {
			createHandler({ namespace: "background", router: bgRouter });
			createHandler({ namespace: "other", router: otherSwRouter });
		});
	});

	const contentT = initWERPC();
	const contentPings = { count: 0, tabs: [] as (number | undefined)[] };
	const contentRouter = contentT.router({
		ping: contentT.procedure.query(({ ctx }) => {
			contentPings.count++;
			contentPings.tabs.push(ctx.tabId);
			return `content tab ${ctx.tabId}`;
		}),
	});

	let content1Client: unknown;
	let content2Client: unknown;

	inContext(ext, "content1", "content", { tab: { id: 1 } }, () => {
		createHandler({ namespace: "content", router: contentRouter });
		content1Client = createClient({ clientName: "content1", scopeToTab: true });
	});

	inContext(ext, "content2", "content", { tab: { id: 2 } }, () => {
		createHandler({ namespace: "content", router: contentRouter });
		content2Client = createClient({ clientName: "content2", scopeToTab: true });
	});

	let popupClient: unknown;
	inContext(ext, "popup", "page", undefined, () => {
		popupClient = createClient({ clientName: "popup" });
	});

	return {
		ext,
		contentPings,
		background: ns<typeof bgRouter>(popupClient, "background"),
		other: ns<typeof otherSwRouter>(popupClient, "other"),
		contentFromPopup: ns<typeof contentRouter>(popupClient, "content"),
		contentFromTab1: ns<typeof contentRouter>(content1Client, "content"),
		contentFromTab2: ns<typeof contentRouter>(content2Client, "content"),
	};
};

describe("routing", () => {
	it("executes a procedure once even when multiple tabs own the namespace", async () => {
		const { contentFromPopup, contentPings } = setup();

		await expect(withTimeout(contentFromPopup.ping.query(), 2000, "ping")).resolves.toMatch(
			/content tab/,
		);

		expect(contentPings.count).toBe(1);
	});

	it("routes tab-scoped clients to the handler in their own tab", async () => {
		const { contentFromTab1, contentFromTab2, contentPings } = setup();

		await expect(withTimeout(contentFromTab1.ping.query(), 2000, "tab1")).resolves.toBe(
			"content tab 1",
		);
		await expect(withTimeout(contentFromTab2.ping.query(), 2000, "tab2")).resolves.toBe(
			"content tab 2",
		);

		expect(contentPings.tabs).toEqual([1, 2]);
	});

	it("routes to multiple handlers inside the same service worker", async () => {
		const { background, other } = setup();

		await expect(withTimeout(background.ping.query(), 2000, "bg")).resolves.toBe("pong");
		await expect(withTimeout(other.ping.query(), 2000, "other")).resolves.toBe(
			"second sw handler",
		);
	});

	it("rejects requests for an unknown namespace instead of hanging", async () => {
		const { ext } = setup();
		const t = initWERPC();
		const router = t.router({ ping: t.procedure.query(() => "x") });

		let client: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup" });
		});

		await expect(
			withTimeout(ns<typeof router>(client, "nosuch").ping.query(), 3000, "nosuch"),
		).rejects.toThrow(/namespace not found/i);
	});

	it("does not amplify messages: a query round-trip stays under a handful of hops", async () => {
		const { ext, background } = setup();
		const before = ext.messageCount;

		await withTimeout(background.ping.query(), 2000, "ping");

		expect(ext.messageCount - before).toBeLessThanOrEqual(6);
	});

	it("keeps serving after the target handler's port dies", async () => {
		const { ext, contentFromPopup, contentPings } = setup();

		await withTimeout(contentFromPopup.ping.query(), 2000, "first");
		expect(contentPings.count).toBe(1);

		// both tabs connected; kill the one serving requests (the first owner)
		ext.killSilently("content1");

		// remaining owner (content2) takes over after eviction
		let result: string | undefined;
		for (let attempt = 0; attempt < 10 && result === undefined; attempt++) {
			try {
				result = await withTimeout(contentFromPopup.ping.query(), 500, `retry ${attempt}`);
			} catch {
				await sleep(50);
			}
		}

		expect(result).toMatch(/content tab/);
	}, 15_000);
});
