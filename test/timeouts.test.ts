import { TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
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

describe("timeouts", () => {
	it("rejects a query that exceeds timeoutMs instead of hanging", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const bgRouter = t.router({
			slow: t.procedure.query(async () => {
				await sleep(1000);
				return "finally";
			}),
		});

		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				createHandler({ namespace: "background", router: bgRouter });
			});
		});

		let client: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup", timeoutMs: 150 });
		});

		await expect(
			withTimeout(ns<typeof bgRouter>(client, "background").slow.query(), 2000, "slow"),
		).rejects.toThrow(/timed out/i);
	});

	it("still allows opting out of timeouts", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const bgRouter = t.router({
			slow: t.procedure.query(async () => {
				await sleep(250);
				return "finally";
			}),
		});

		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				createHandler({ namespace: "background", router: bgRouter });
			});
		});

		let client: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup", timeoutMs: 0 });
		});

		await expect(
			withTimeout(ns<typeof bgRouter>(client, "background").slow.query(), 2000, "slow"),
		).resolves.toBe("finally");
	});
});

describe("subscription retries", () => {
	it("re-acks duplicate starts instead of erroring, and subscribes once", async () => {
		const ext = new FakeExtension();
		const starts = { count: 0 };

		const t = initWERPC();
		const bgRouter = t.router({
			poll: t.procedure.subscription(async function* () {
				starts.count++;
				for (let i = 0; i < 3; i++) {
					yield i;
					await sleep(10);
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

		// slow delivery makes the client's 1s retry fire before the first ack
		ext.delayMs = 1200;

		const chunks: number[] = [];
		const done = await withTimeout(
			new Promise<string>(resolve =>
				ns<typeof bgRouter>(client, "background").poll.subscribe(undefined, {
					onData: chunk => chunks.push(chunk),
					onError: () => resolve("error"),
					onComplete: () => resolve("done"),
				}),
			),
			25_000,
			"poll",
		);

		expect(done).toBe("done");
		expect(chunks).toEqual([0, 1, 2]);
		expect(starts.count).toBe(1);
	}, 30_000);
});
