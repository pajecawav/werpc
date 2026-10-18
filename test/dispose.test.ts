import { TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createClient, createHandler, initWERPC, WERPCHandler } from "../src/index.ts";
import { acquireKeepAlive, keepAliveState, releaseKeepAlive } from "../src/keep-alive.ts";
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

describe("dispose", () => {
	it("handler.dispose() unregisters the namespace from routing", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const bgRouter = t.router({ ping: t.procedure.query(() => "pong") });

		let handler: WERPCHandler<"background", typeof bgRouter> | undefined;
		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				handler = createHandler({ namespace: "background", router: bgRouter });
			});
		});

		let client: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup" });
		});

		await expect(
			withTimeout(ns<typeof bgRouter>(client, "background").ping.query(), 2000, "before"),
		).resolves.toBe("pong");

		handler?.dispose();

		await expect(
			withTimeout(ns<typeof bgRouter>(client, "background").ping.query(), 3000, "after"),
		).rejects.toThrow(/namespace not found/i);
	});

	it("client.dispose() closes the port; further calls throw", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const bgRouter = t.router({ ping: t.procedure.query(() => "pong") });

		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				createHandler({ namespace: "background", router: bgRouter });
			});
		});

		let client: ReturnType<typeof createClient> | undefined;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup" });
		});

		await expect(
			withTimeout(ns<typeof bgRouter>(client, "background").ping.query(), 2000, "before"),
		).resolves.toBe("pong");

		client?.dispose();

		await expect(ns<typeof bgRouter>(client, "background").ping.query()).rejects.toThrow(
			/closed/i,
		);
	});

	it("client proxy does not throw on symbol access", () => {
		const ext = new FakeExtension();

		let client: ReturnType<typeof createClient> | undefined;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup" });
		});

		expect((client as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
		expect(String(client?.constructor?.name)).toBeTruthy();
	});
});

describe("keep-alive", () => {
	it("acquire/release refcounting starts and stops the interval", () => {
		const initial = keepAliveState();
		expect(initial.active).toBe(false);

		acquireKeepAlive();
		acquireKeepAlive();
		expect(keepAliveState()).toMatchObject({ refCount: 2, active: true });

		releaseKeepAlive();
		expect(keepAliveState()).toMatchObject({ refCount: 1, active: true });

		releaseKeepAlive();
		expect(keepAliveState()).toMatchObject({ refCount: 0, active: false });

		// over-release is clamped
		releaseKeepAlive();
		expect(keepAliveState().refCount).toBe(0);
	});

	it("runs only while subscriptions are active", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const abortFlag = { aborted: false };
		const bgRouter = t.router({
			infinite: t.procedure.subscription(async function* ({ signal }) {
				try {
					for (;;) {
						if (signal?.aborted) {
							break;
						}
						yield 1;
						await sleep(20);
					}
				} finally {
					if (signal?.aborted) {
						abortFlag.aborted = true;
					}
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

		expect(keepAliveState().active).toBe(false);

		const unsub = ns<typeof bgRouter>(client, "background").infinite.subscribe(undefined, {
			onData: () => undefined,
		});

		await sleep(50);
		expect(keepAliveState().active).toBe(true);

		unsub.unsubscribe();
		await sleep(50);
		expect(keepAliveState().active).toBe(false);
	});
});
