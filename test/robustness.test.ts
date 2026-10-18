import { TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createClient, createHandler, initWERPC } from "../src/index.ts";
import { router } from "../src/router.ts";
import { FakeExtension, withTimeout } from "./harness/hub.ts";
import { inContext, swMode } from "./harness/werpc.ts";

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

describe("port robustness", () => {
	it("recovers a query when the client's port dies silently", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const bgRouter = t.router({ ping: t.procedure.query(() => "pong") });

		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				createHandler({ namespace: "background", router: bgRouter });
			});
		});

		let client: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup" });
		});

		// sanity: normal flow works
		await expect(
			withTimeout(ns<typeof bgRouter>(client, "background").ping.query(), 2000, "warmup"),
		).resolves.toBe("pong");

		// port object goes stale without onDisconnect reaching the SW
		ext.killSilently("popup");

		await expect(
			withTimeout(ns<typeof bgRouter>(client, "background").ping.query(), 2000, "after kill"),
		).resolves.toBe("pong");
	});
});
