/**
 * Helpers to run multiple werpc "contexts" inside one test process:
 * each context installs its own fake `chrome` global before constructing
 * handlers/clients, and `swMode` emulates the ServiceWorkerGlobalScope check
 * used by `detectContext()`.
 */

import type { FakeExtension, FakeSender, ContextKind } from "./hub";

export const swMode = <T>(fn: () => T): T => {
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	const ServiceWorkerGlobalScope = function () {};
	const g = globalThis as unknown as Record<string, unknown>;
	const prevSelf = g["self"];
	g["ServiceWorkerGlobalScope"] = ServiceWorkerGlobalScope;
	g["self"] = Object.create(ServiceWorkerGlobalScope.prototype);
	try {
		return fn();
	} finally {
		delete g["ServiceWorkerGlobalScope"];
		g["self"] = prevSelf;
	}
};

/**
 * Emulates the Firefox MV3 background: no ServiceWorkerGlobalScope, and
 * `location` at the fixed generated event-page path — the pair
 * `detectContext()` keys on.
 */
export const eventPageMode = <T>(fn: () => T): T => {
	const g = globalThis as unknown as Record<string, unknown>;
	const prevSelf = g["self"];
	const prevLocation = g["location"];
	g["self"] = globalThis;
	Object.defineProperty(g, "location", {
		value: new URL("moz-extension://some-uuid/_generated_background_page.html"),
		configurable: true,
	});
	try {
		return fn();
	} finally {
		g["self"] = prevSelf;
		if (prevLocation === undefined) {
			delete g["location"];
		} else {
			Object.defineProperty(g, "location", {
				value: prevLocation,
				configurable: true,
			});
		}
	}
};

export const inContext = <T>(
	ext: FakeExtension,
	ctxId: string,
	kind: ContextKind,
	sender: FakeSender | undefined,
	fn: () => T,
): T => {
	ext.context(ctxId, kind, sender);
	// keep installed: WERPCPort may reconnect later and needs chrome.runtime.connect
	(globalThis as { chrome?: unknown }).chrome = ext.makeChrome(ctxId);
	return fn();
};
