import { TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "../src/events.ts";
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

// track listener add/remove across EventEmitter instances in this module registry
const counts = { active: 0 };
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalOn = EventEmitter.prototype.on;
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalOff = EventEmitter.prototype.off;
EventEmitter.prototype.on = function (this: unknown, ...args: Parameters<typeof originalOn>) {
	counts.active++;
	return originalOn.apply(this, args);
};
EventEmitter.prototype.off = function (this: unknown, ...args: Parameters<typeof originalOff>) {
	counts.active--;
	return originalOff.apply(this, args);
};

beforeEach(() => {
	router.reset();
});

describe("link hygiene", () => {
	it("does not leak event listeners for completed queries", async () => {
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

		const before = counts.active;

		for (let i = 0; i < 10; i++) {
			await withTimeout(
				ns<typeof bgRouter>(client, "background").ping.query(),
				2000,
				`ping ${i}`,
			);
		}
		await sleep(100);

		expect(counts.active).toBe(before);
	});

	it("does not send subscription.stop for plain queries", async () => {
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

		await withTimeout(ns<typeof bgRouter>(client, "background").ping.query(), 2000, "ping");
		await sleep(100);

		const stops = ext.log.filter(entry => entry.type === "subscription.stop");
		expect(stops).toEqual([]);
	});
});

describe("subscription cleanup on client death", () => {
	it("aborts SW subscriptions when the client port disconnects", async () => {
		const ext = new FakeExtension();
		const abortFlag = { aborted: false };
		const t = initWERPC();
		const bgRouter = t.router({
			infinite: t.procedure.subscription(async function* ({ signal }) {
				try {
					for (;;) {
						if (signal?.aborted) {
							break;
						}
						yield Date.now();
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

		let resolveFirst: () => void;
		const firstChunk = new Promise<void>(resolve => {
			resolveFirst = resolve;
		});
		ns<typeof bgRouter>(client, "background").infinite.subscribe(undefined, {
			onData: () => resolveFirst(),
		});

		await withTimeout(firstChunk, 2000, "first chunk");

		ext.disconnect("popup");

		await withTimeout(
			new Promise<void>(resolve => {
				const check = () => {
					if (abortFlag.aborted) {
						resolve();
					} else {
						setTimeout(check, 10);
					}
				};
				check();
			}),
			2000,
			"abort flag",
		);
	});

	it("aborts content-script subscriptions when the client port disconnects", async () => {
		const ext = new FakeExtension();
		const abortFlag = { aborted: false };
		const t = initWERPC();
		const bgRouter = t.router({ ok: t.procedure.query(() => true) });
		const contentRouter = t.router({
			infinite: t.procedure.subscription(async function* ({ signal }) {
				try {
					for (;;) {
						if (signal?.aborted) {
							break;
						}
						yield Date.now();
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

		inContext(ext, "content1", "content", { tab: { id: 1 } }, () => {
			createHandler({ namespace: "content", router: contentRouter });
		});

		let client: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			client = createClient({ clientName: "popup" });
		});

		let resolveFirst: () => void;
		const firstChunk = new Promise<void>(resolve => {
			resolveFirst = resolve;
		});
		ns<typeof contentRouter>(client, "content").infinite.subscribe(undefined, {
			onData: () => resolveFirst(),
		});

		await withTimeout(firstChunk, 2000, "first chunk");

		ext.disconnect("popup");

		await withTimeout(
			new Promise<void>(resolve => {
				const check = () => {
					if (abortFlag.aborted) {
						resolve();
					} else {
						setTimeout(check, 10);
					}
				};
				check();
			}),
			2000,
			"abort flag",
		);
	});
});
