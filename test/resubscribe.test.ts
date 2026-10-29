import { TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, createHandler, initWERPC } from "../src/index.ts";
import { router } from "../src/router.ts";
import { FakeExtension, sleep, withTimeout } from "./harness/hub.ts";
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

describe("subscription resurrection", () => {
	it("resumes a live subscription after the client's port reconnects", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();

		// The background idles and every port dies (Firefox event pages
		// ignore open ports entirely; Chrome SWs do it under pressure).
		// When the client reconnects, an already-acked subscription must
		// announce itself again — the retry loop stopped at the ack.
		const bgRouter = t.router({
			ticks: t.procedure.subscription(async function* ({ signal }) {
				// oxlint-disable-next-line eslint/no-unmodified-loop-condition
				for (let n = 0; !signal?.aborted; n++) {
					yield n;
					await sleep(30);
				}
			}),
		});

		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				createHandler({ namespace: "background", router: bgRouter });
			});
		});

		let client: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup" });
		});

		const values: number[] = [];
		const subscription = ns<typeof bgRouter>(client, "background").ticks.subscribe(undefined, {
			onData: value => values.push(value),
		});

		// sanity: the stream flows
		await vi.waitFor(() => expect(values.length).toBeGreaterThanOrEqual(2));

		// the hub died: the client's port drops and werpc reconnects it.
		// The old generator was aborted with the client's route; the
		// re-announced start spins up a fresh stream.
		const before = values.length;
		ext.disconnect("popup");
		await withTimeout(
			vi.waitFor(() => expect(values.length).toBeGreaterThan(before), { timeout: 3000 }),
			3500,
			"resumed tick",
		);

		subscription.unsubscribe();
	});

	it("does not resurrect a subscription that received a stop", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();

		let releases: Array<(v: number) => void> = [];
		const bgRouter = t.router({
			counted: t.procedure.subscription(async function* ({ signal }) {
				let n = 0;
				// oxlint-disable-next-line eslint/no-unmodified-loop-condition
				while (!signal?.aborted) {
					const value = await new Promise<number>(resolve => {
						releases.push(resolve);
					});
					yield value + n++;
				}
			}),
		});

		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				createHandler({ namespace: "background", router: bgRouter });
			});
		});

		let client: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup" });
		});

		const values: number[] = [];
		const subscription = ns<typeof bgRouter>(client, "background").counted.subscribe(
			undefined,
			{ onData: value => values.push(value) },
		);

		await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
		releases.shift()?.(1);
		await vi.waitFor(() => expect(values).toEqual([1]));

		// the observer goes away BEFORE the port dies: cleanup posts
		// subscription.stop, so a later reconnect must re-send nothing
		subscription.unsubscribe();
		await sleep(20);
		const requestsBefore = ext.log.filter(
			entry => entry.type === "subscription.start" && entry.ns === "background",
		).length;

		ext.disconnect("popup");
		await sleep(50);

		const requestsAfter = ext.log.filter(
			entry => entry.type === "subscription.start" && entry.ns === "background",
		).length;
		expect(requestsAfter).toBe(requestsBefore);
	});
});
