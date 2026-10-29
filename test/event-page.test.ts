import { TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createClient, createHandler, initWERPC } from "../src/index.ts";
import { router } from "../src/router.ts";
import { FakeExtension, withTimeout } from "./harness/hub.ts";
import { eventPageMode, inContext } from "./harness/werpc.ts";

const ns = <R extends AnyRouter>(client: unknown, name: string): TRPCClient<R> => {
	const value = (client as Record<string, TRPCClient<R>>)[name];
	if (!value) {
		throw new Error(`namespace ${name} not found on client`);
	}
	return value;
};

beforeEach(() => {
	router.reset();
});

describe("event page background (Firefox MV3)", () => {
	it("serves queries and subscriptions from an event page background", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const bgRouter = t.router({
			ping: t.procedure.query(() => "pong"),
		});

		// Firefox: no service worker scope — the background is a document
		// at the generated event-page path. The context kind is still "sw"
		// (an event page receives runtime.onConnect like a Chrome SW).
		inContext(ext, "bg", "sw", undefined, () => {
			eventPageMode(() => {
				createHandler({ namespace: "background", router: bgRouter });
			});
		});

		let client: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup" });
		});

		await expect(
			withTimeout(ns<typeof bgRouter>(client, "background").ping.query(), 2000, "ping"),
		).resolves.toBe("pong");
	});

	it("accepts an explicit background override for custom background pages", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const bgRouter = t.router({
			ping: t.procedure.query(() => "pong"),
		});

		// A custom background.page document has its own path — detection
		// cannot see it; the option forces server behavior.
		inContext(ext, "bg", "sw", undefined, () => {
			createHandler({ namespace: "background", router: bgRouter, background: true });
		});

		let client: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup" });
		});

		await expect(
			withTimeout(ns<typeof bgRouter>(client, "background").ping.query(), 2000, "ping"),
		).resolves.toBe("pong");
	});

	it("refuses clients in an event page context", () => {
		const ext = new FakeExtension();

		expect(() =>
			inContext(ext, "bg", "sw", undefined, () =>
				eventPageMode(() => {
					createClient({ clientName: "bg" });
				}),
			),
		).toThrow(/background context/);
	});
});
