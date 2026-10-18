import { isTRPCClientError, TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { createClient, createHandler, initWERPC } from "../src/index.ts";
import { FakeExtension, sleep, withTimeout } from "./harness/hub.ts";
import { inContext, swMode } from "./harness/werpc.ts";

const ns = <R extends AnyRouter>(client: unknown, name: string): TRPCClient<R> => {
	const value = (client as Record<string, TRPCClient<R>>)[name];
	if (!value) {
		throw new Error(`namespace ${name} not found on client`);
	}
	return value;
};

const setup = () => {
	const ext = new FakeExtension();
	const t = initWERPC();
	const router = t.router({
		boom: t.procedure.query(() => {
			throw new Error("kaboom");
		}),
		boomMutation: t.procedure.mutation(() => Promise.reject(new Error("mutation failed"))),
		leaky: t.procedure.subscription(async function* () {
			yield "first";
			await sleep(20);
			throw new Error("stream exploded");
		}),
		ok: t.procedure.query(() => "fine"),
	});

	inContext(ext, "bg", "sw", undefined, () => {
		swMode(() => {
			createHandler({ namespace: "background", router });
		});
	});

	let client: unknown;
	inContext(ext, "popup", "page", undefined, () => {
		client = createClient({ clientName: "popup" });
	});

	return { ext, background: ns<typeof router>(client, "background") };
};

describe("error propagation", () => {
	it("rejects a query whose procedure throws", async () => {
		const { background } = setup();
		const promise = background.boom.query();

		await expect(withTimeout(promise, 2000, "boom")).rejects.toSatisfy((error: unknown) => {
			if (!isTRPCClientError(error)) {
				return false;
			}
			expect(error.message).toContain("kaboom");
			return true;
		});
	});

	it("rejects a mutation whose procedure throws", async () => {
		const { background } = setup();
		await expect(
			withTimeout(background.boomMutation.mutate(), 2000, "boomMutation"),
		).rejects.toSatisfy(
			(error: unknown) =>
				isTRPCClientError(error) && error.message.includes("mutation failed"),
		);
	});

	it("rejects a query for a missing procedure instead of hanging", async () => {
		const { background } = setup();
		// @ts-expect-error -- intentionally wrong procedure path
		const promise = background.nope.query();
		await expect(withTimeout(promise, 2000, "nope")).rejects.toSatisfy((error: unknown) => {
			if (!isTRPCClientError(error)) {
				return false;
			}
			expect(error.message.toLowerCase()).toContain("procedure");
			expect(error.message.toLowerCase()).toContain("nope");
			return true;
		});
	});

	it("reports a subscription that throws mid-stream via onError", async () => {
		const { background } = setup();
		const chunks: string[] = [];
		const result = await withTimeout(
			new Promise<{ error?: unknown }>(resolve =>
				background.leaky.subscribe(undefined, {
					onData: chunk => chunks.push(chunk),
					onError: error => resolve({ error }),
					onComplete: () => resolve({}),
				}),
			),
			3000,
			"leaky",
		);

		expect(chunks).toEqual(["first"]);
		expect(isTRPCClientError(result.error)).toBe(true);
		expect((result.error as Error).message).toContain("stream exploded");
	});

	it("still resolves successful queries alongside erroring ones", async () => {
		const { background } = setup();
		await expect(background.boom.query()).rejects.toThrow();
		await expect(withTimeout(background.ok.query(), 2000, "ok")).resolves.toBe("fine");
	});
});
