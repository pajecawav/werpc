import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireKeepAlive, keepAliveState, releaseKeepAlive } from "../src/keep-alive";

type Runtime = Record<string, unknown>;

const installRuntime = (runtime: Runtime) => {
	const prev = (globalThis as { chrome?: unknown }).chrome;
	(globalThis as { chrome?: unknown }).chrome = { runtime };
	return () => {
		(globalThis as { chrome?: unknown }).chrome = prev;
	};
};

afterEach(() => {
	releaseKeepAlive();
	vi.useRealTimers();
});

describe("keep-alive", () => {
	it("calls the extension API from a full-surface context (SW / page)", () => {
		const getPlatformInfo = vi.fn();
		const restore = installRuntime({ getPlatformInfo });
		vi.useFakeTimers();

		acquireKeepAlive();
		vi.advanceTimersByTime(45_000);

		expect(getPlatformInfo).toHaveBeenCalledTimes(2);
		restore();
	});

	it("survives content scripts, where getPlatformInfo does not exist", () => {
		// Real Chrome gives content scripts a reduced chrome.runtime — the
		// tick used to throw there every 20s (and could not reach the SW
		// idle timer anyway).
		const restore = installRuntime({ onConnect: {} });
		vi.useFakeTimers();

		acquireKeepAlive();
		expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
		expect(keepAliveState().active).toBe(true);

		restore();
	});

	it("stops ticking when the last subscription goes away", () => {
		const getPlatformInfo = vi.fn();
		const restore = installRuntime({ getPlatformInfo });
		vi.useFakeTimers();

		acquireKeepAlive();
		acquireKeepAlive();
		releaseKeepAlive();
		// one subscription is still holding the timer up
		vi.advanceTimersByTime(25_000);
		expect(getPlatformInfo).toHaveBeenCalledTimes(1);

		releaseKeepAlive();
		vi.advanceTimersByTime(60_000);
		expect(getPlatformInfo).toHaveBeenCalledTimes(1);
		expect(keepAliveState().active).toBe(false);

		restore();
	});
});
