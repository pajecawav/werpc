/**
 * Helpers to run multiple werpc "contexts" inside one test process:
 * each context installs its own fake `chrome` global before constructing
 * handlers/clients, and `swMode` emulates the ServiceWorkerGlobalScope check
 * used by `detectContext()`.
 */

import type { FakeExtension, FakeSender, ContextKind } from "./hub";

export const swMode = <T>(fn: () => T): T => {
	const ServiceWorkerGlobalScope = class {};
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
