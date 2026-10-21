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

const waitFor = (flag: { value: boolean }, label: string) =>
	withTimeout(
		new Promise<void>(resolve => {
			const check = () => {
				if (flag.value) {
					resolve();
				} else {
					setTimeout(check, 10);
				}
			};
			check();
		}),
		3000,
		label,
	);

beforeEach(() => {
	router.reset();
});

describe("multiple client subscribers (sanity)", () => {
	it("delivers independent streams to two clients in the same tab", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const bgRouter = t.router({
			poll: t.procedure.subscription(async function* ({ signal, ctx }) {
				for (let i = 0; i < 3; i++) {
					if (signal?.aborted) {
						break;
					}
					yield `${ctx.clientName}:${i}`;
					await sleep(10);
				}
			}),
		});

		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				createHandler({ namespace: "background", router: bgRouter });
			});
		});

		let clientA: unknown;
		let clientB: unknown;
		inContext(ext, "contentA", "content", { tab: { id: 7 } }, () => {
			clientA = createClient({ clientName: "A", scopeToTab: true });
		});
		inContext(ext, "contentB", "content", { tab: { id: 7 } }, () => {
			clientB = createClient({ clientName: "B", scopeToTab: true });
		});

		const collect = (client: unknown) => {
			const chunks: string[] = [];
			return new Promise<string[]>(resolve =>
				ns<typeof bgRouter>(client, "background").poll.subscribe(undefined, {
					onData: chunk => chunks.push(chunk),
					onComplete: () => resolve([...chunks]),
				}),
			);
		};

		const [a, b] = await Promise.all([
			withTimeout(collect(clientA), 3000, "A"),
			withTimeout(collect(clientB), 3000, "B"),
		]);

		expect(a.every(chunk => chunk.startsWith("A:"))).toBe(true);
		expect(a).toHaveLength(3);
		expect(b.every(chunk => chunk.startsWith("B:"))).toBe(true);
		expect(b).toHaveLength(3);
	});
});

const setupFanout = () => {
	const ext = new FakeExtension();
	const t = initWERPC();
	const executions = { script: 0, panel: 0 };
	const scriptAborted = { value: false };
	const panelAborted = { value: false };

	const bgRouter = t.router({ ok: t.procedure.query(() => true) });

	// two different routers served under the SAME namespace in the SAME tab:
	// a content script (sender tab 1) and a "devtools panel" (explicit tabId)
	const scriptRouter = t.router({
		whoami: t.procedure.query(() => {
			executions.script++;
			return "script";
		}),
		tick: t.procedure.subscription(async function* ({ signal }) {
			try {
				for (let i = 0; i < 3; i++) {
					if (signal?.aborted) {
						break;
					}
					yield `script:${i}`;
					await sleep(10);
				}
			} finally {
				if (signal?.aborted) {
					scriptAborted.value = true;
				}
			}
		}),
	});
	const panelRouter = t.router({
		whoami: t.procedure.query(() => {
			executions.panel++;
			return "panel";
		}),
		tick: t.procedure.subscription(async function* ({ signal }) {
			try {
				for (let i = 0; i < 3; i++) {
					if (signal?.aborted) {
						break;
					}
					yield `panel:${i}`;
					await sleep(10);
				}
			} finally {
				if (signal?.aborted) {
					panelAborted.value = true;
				}
			}
		}),
	});

	inContext(ext, "bg", "sw", undefined, () => {
		swMode(() => {
			createHandler({ namespace: "background", router: bgRouter });
		});
	});

	inContext(ext, "script", "content", { tab: { id: 1 } }, () => {
		createHandler({ namespace: "tool", router: scriptRouter });
	});

	// a page context without a sender tab, like a devtools panel
	inContext(ext, "panel", "page", undefined, () => {
		createHandler({ namespace: "tool", router: panelRouter, tabId: 1 });
	});

	return { ext, executions, scriptAborted, panelAborted, scriptRouter, panelRouter };
};

describe("fan-out to multiple namespace owners", () => {
	it("by default a query still reaches exactly one owner", async () => {
		const { ext, executions, scriptRouter } = setupFanout();

		let plainClient: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			plainClient = createClient({ clientName: "popup" });
		});

		await withTimeout(ns<typeof scriptRouter>(plainClient, "tool").whoami.query(), 3000, "one");

		expect(executions.script + executions.panel).toBe(1);
	});

	it("fanout query reaches every owner of the namespace", async () => {
		const { ext, executions, scriptRouter } = setupFanout();

		let fanoutClient: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			fanoutClient = createClient({ clientName: "popup", fanout: true });
		});

		const result = await withTimeout(
			ns<typeof scriptRouter>(fanoutClient, "tool").whoami.query(),
			3000,
			"fanout",
		);

		// the query resolves on the first response; wait for the other owner
		await waitFor(
			{
				get value() {
					return executions.script >= 1 && executions.panel >= 1;
				},
			},
			"both owners executed",
		);
		expect(["script", "panel"]).toContain(result);
		expect(executions.script).toBe(1);
		expect(executions.panel).toBe(1);
	});

	it("scopeToTab fanout reaches only the owners in that tab", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const executions = { tab1: 0, tab2: 0 };
		const router1 = t.router({
			ping: t.procedure.query(() => {
				executions.tab1++;
				return "tab1";
			}),
		});
		const router2 = t.router({
			ping: t.procedure.query(() => {
				executions.tab2++;
				return "tab2";
			}),
		});

		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				createHandler({
					namespace: "background",
					router: t.router({ ok: t.procedure.query(() => 1) }),
				});
			});
		});
		inContext(ext, "tab1", "content", { tab: { id: 1 } }, () => {
			createHandler({ namespace: "tool", router: router1 });
		});
		inContext(ext, "tab2", "content", { tab: { id: 2 } }, () => {
			createHandler({ namespace: "tool", router: router2 });
		});

		let fanoutClient: unknown;
		inContext(ext, "caller", "content", { tab: { id: 1 } }, () => {
			fanoutClient = createClient({ clientName: "caller", scopeToTab: true, fanout: true });
		});

		await withTimeout(
			ns<typeof router1>(fanoutClient, "tool").ping.query(),
			3000,
			"scoped fanout",
		);

		expect(executions.tab1).toBe(1);
		expect(executions.tab2).toBe(0);
	});

	it("fanout subscription merges streams from all owners and unsubscribe stops them all", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const scriptAborted = { value: false };
		const panelAborted = { value: false };
		const bgRouter = t.router({ ok: t.procedure.query(() => true) });
		const toolRouter = t.router({
			tick: t.procedure.subscription(async function* ({ signal }) {
				try {
					for (let i = 0; ; i++) {
						if (signal?.aborted) {
							break;
						}
						yield `script:${i}`;
						await sleep(10);
					}
				} finally {
					if (signal?.aborted) {
						scriptAborted.value = true;
					}
				}
			}),
		});
		const panelRouter = t.router({
			tick: t.procedure.subscription(async function* ({ signal }) {
				try {
					for (let i = 0; ; i++) {
						if (signal?.aborted) {
							break;
						}
						yield `panel:${i}`;
						await sleep(10);
					}
				} finally {
					if (signal?.aborted) {
						panelAborted.value = true;
					}
				}
			}),
		});

		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				createHandler({ namespace: "background", router: bgRouter });
			});
		});
		inContext(ext, "script", "content", { tab: { id: 1 } }, () => {
			createHandler({ namespace: "tool", router: toolRouter });
		});
		inContext(ext, "panel", "page", undefined, () => {
			createHandler({ namespace: "tool", router: panelRouter, tabId: 1 });
		});

		let fanoutClient: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			fanoutClient = createClient({ clientName: "popup", fanout: true });
		});

		const chunks: string[] = [];
		let resolveFirst: () => void;
		const firstBatch = new Promise<void>(resolve => {
			resolveFirst = resolve;
		});

		const unsub = ns<typeof toolRouter>(fanoutClient, "tool").tick.subscribe(undefined, {
			onData: chunk => {
				chunks.push(chunk);
				resolveFirst();
			},
		});

		await withTimeout(firstBatch, 3000, "first fanout chunk");
		await sleep(80);

		expect(chunks.some(chunk => chunk.startsWith("script:"))).toBe(true);
		expect(chunks.some(chunk => chunk.startsWith("panel:"))).toBe(true);

		unsub.unsubscribe();

		await waitFor(scriptAborted, "script aborted");
		await waitFor(panelAborted, "panel aborted");
	});

	it("fanout without scopeToTab reaches owners in every tab", async () => {
		const ext = new FakeExtension();
		const t = initWERPC();
		const pings = { count: 0 };
		const contentRouter = t.router({
			ping: t.procedure.query(() => {
				pings.count++;
				return "pong";
			}),
		});

		inContext(ext, "bg", "sw", undefined, () => {
			swMode(() => {
				createHandler({
					namespace: "background",
					router: t.router({ ok: t.procedure.query(() => 1) }),
				});
			});
		});
		for (const tabId of [1, 2, 3]) {
			inContext(ext, `tab${tabId}`, "content", { tab: { id: tabId } }, () => {
				createHandler({ namespace: "content", router: contentRouter });
			});
		}

		let fanoutClient: unknown;
		inContext(ext, "popup", "page", undefined, () => {
			fanoutClient = createClient({ clientName: "popup", fanout: true });
		});

		await withTimeout(
			ns<typeof contentRouter>(fanoutClient, "content").ping.query(),
			3000,
			"all tabs",
		);

		expect(pings.count).toBe(3);
	});

	it("handler tabId option participates in tab-scoped fanout routing", async () => {
		const { ext, executions, scriptRouter } = setupFanout();

		// a content client in tab 1: scopeToTab + fanout should reach the
		// content script (sender tab 1) AND the panel (explicit tabId 1)
		let fanoutClient: unknown;
		inContext(ext, "caller", "content", { tab: { id: 1 } }, () => {
			fanoutClient = createClient({ clientName: "caller", scopeToTab: true, fanout: true });
		});

		await withTimeout(
			ns<typeof scriptRouter>(fanoutClient, "tool").whoami.query(),
			3000,
			"tab fanout",
		);

		// responses arrive from both owners; the query resolves on the first,
		// so wait for the second execution rather than asserting immediately
		await waitFor(
			{
				get value() {
					return executions.script >= 1 && executions.panel >= 1;
				},
			},
			"both owners executed",
		);
		expect(executions.script).toBe(1);
		expect(executions.panel).toBe(1);
	});
});
