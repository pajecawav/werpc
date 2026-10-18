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
	const extAbortFlag = { aborted: false };

	const bgT = initWERPC();
	const bgRouter = bgT.router({
		ping: bgT.procedure.query(({ ctx }) => ({
			clientName: ctx.clientName,
			tabId: ctx.tabId ?? null,
		})),
		add: bgT.procedure
			.input((value: unknown): number => {
				if (typeof value !== "number") {
					throw new Error("expected number");
				}
				return value;
			})
			.mutation(({ input }) => input + 1),
		poll: bgT.procedure.subscription(async function* ({ signal }) {
			try {
				for (let i = 0; i < 3; i++) {
					if (signal?.aborted) {
						break;
					}
					yield i;
					await sleep(20);
				}
			} finally {
				if (signal?.aborted) {
					extAbortFlag.aborted = true;
				}
			}
		}),
	});

	inContext(ext, "bg", "sw", undefined, () => {
		swMode(() => {
			createHandler({ namespace: "background", router: bgRouter });
		});
	});

	const contentT = initWERPC();
	const contentRouter = contentT.router({
		ping: contentT.procedure.query(({ ctx }) => `content tab ${ctx.tabId}`),
	});
	const contentPings = { count: 0 };
	const countingRouter = contentT.router({
		ping: contentT.procedure.query(({ ctx }) => {
			contentPings.count++;
			return `content tab ${ctx.tabId}`;
		}),
	});

	let popupClient: unknown;
	let content1Client: unknown;

	inContext(ext, "content1", "content", { tab: { id: 1 } }, () => {
		createHandler({ namespace: "content", router: countingRouter });
		content1Client = createClient({ clientName: "content1", scopeToTab: true });
	});

	inContext(ext, "content2", "content", { tab: { id: 2 } }, () => {
		createHandler({ namespace: "content", router: countingRouter });
	});

	inContext(ext, "popup", "page", undefined, () => {
		popupClient = createClient({ clientName: "popup" });
	});

	return {
		ext,
		extAbortFlag,
		contentPings,
		background: ns<typeof bgRouter>(popupClient, "background"),
		content: ns<typeof contentRouter>(popupClient, "content"),
		content1: ns<typeof contentRouter>(content1Client, "content"),
	};
};

describe("werpc baseline", () => {
	it("resolves a query with data and populated context", async () => {
		const { background } = setup();
		const result = await withTimeout(background.ping.query(), 2000, "ping");
		expect(result).toEqual({ clientName: "popup", tabId: null });
	});

	it("resolves a mutation with parsed input", async () => {
		const { background } = setup();
		await expect(withTimeout(background.add.mutate(41), 2000, "add")).resolves.toBe(42);
	});

	it("streams a subscription to completion", async () => {
		const { background } = setup();
		const chunks: number[] = [];
		const done = await withTimeout(
			new Promise<string>(resolve =>
				background.poll.subscribe(undefined, {
					onData: chunk => chunks.push(chunk),
					onComplete: () => resolve("done"),
				}),
			),
			3000,
			"poll",
		);
		expect(done).toBe("done");
		expect(chunks).toEqual([0, 1, 2]);
	});

	it("aborts the server-side generator on unsubscribe", async () => {
		const { background, extAbortFlag } = setup();
		let resolveFirst: () => void;
		const firstChunk = new Promise<void>(resolve => {
			resolveFirst = resolve;
		});

		const unsub = background.poll.subscribe(undefined, {
			onData: () => resolveFirst(),
		});

		await withTimeout(firstChunk, 2000, "first chunk");
		unsub.unsubscribe();

		await withTimeout(
			new Promise<void>(resolve => {
				const check = () => {
					if (extAbortFlag.aborted) {
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

describe("werpc context guards", () => {
	it("throws when creating a client in a service worker", () => {
		const ext = new FakeExtension();
		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				expect(() => createClient({})).toThrow(/background worker context/i);
			});
		});
	});

	it("fills ctx.tabId with the calling tab, not the handler's tab", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const contentRouter = t.router({
			ping: t.procedure.query(({ ctx }) => `content tab ${ctx.tabId}`),
		});
		const backgroundRouter = t.router({
			echoCallerTab: t.procedure.query(({ ctx }) => `caller tab ${ctx.tabId ?? "none"}`),
		});

		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				createHandler({ namespace: "background", router: backgroundRouter });
			});
		});

		let contentClient: unknown;
		inContext(ext, "content1", "content", { tab: { id: 7 } }, () => {
			createHandler({ namespace: "content", router: contentRouter });
			contentClient = createClient({ clientName: "content1", scopeToTab: true });
		});

		await expect(
			withTimeout(
				ns<typeof backgroundRouter>(contentClient, "background").echoCallerTab.query(),
				2000,
				"echo",
			),
		).resolves.toBe("caller tab 7");
	});
});
