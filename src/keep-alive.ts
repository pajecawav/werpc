/**
 * Keeps the service worker alive while there are active subscriptions.
 * Queries survive SW restarts by design; subscriptions would lose their
 * stream, so while any subscription is alive we reset the idle timer with
 * a cheap extension API call every 20 seconds.
 */

const KEEP_ALIVE_INTERVAL_MS = 20_000;

let refCount = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const tick = () => {
	// Content scripts expose a reduced chrome.runtime — getPlatformInfo is
	// absent there, and extension API calls made from a content script
	// cannot reset the service worker's idle timer anyway. Skip quietly:
	// service workers and extension pages keep the full surface.
	const platformInfo = chrome.runtime?.getPlatformInfo;
	if (typeof platformInfo !== "function") {
		return;
	}
	platformInfo.call(chrome.runtime);
};

export const acquireKeepAlive = () => {
	refCount++;

	if (timer === undefined) {
		timer = setInterval(tick, KEEP_ALIVE_INTERVAL_MS);
	}
};

export const releaseKeepAlive = () => {
	refCount = Math.max(0, refCount - 1);

	if (refCount === 0 && timer !== undefined) {
		clearInterval(timer);
		timer = undefined;
	}
};

/** @internal -- test inspection only */
export const keepAliveState = () => ({ refCount, active: timer !== undefined });
