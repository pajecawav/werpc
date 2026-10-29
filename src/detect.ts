export type WerpcContext = "service_worker" | "event_page" | "unknown";

/**
 * The document path browsers generate for `background.scripts` when no
 * `background.page` is specified. Firefox (and Safari) run MV3
 * backgrounds as such event pages — regular documents, no service
 * worker scope — at exactly this path.
 */
const GENERATED_BACKGROUND_PAGE = "/_generated_background_page.html";

export const detectContext = (): WerpcContext => {
	if (
		// @ts-expect-error TS-2304
		typeof ServiceWorkerGlobalScope !== "undefined" &&
		// @ts-expect-error TS-2304
		self instanceof ServiceWorkerGlobalScope
	) {
		return "service_worker";
	}

	// Firefox MV3 has no background service worker: the background is an
	// event page — a hidden document sharing the router's privileges.
	if (typeof location !== "undefined" && location.pathname === GENERATED_BACKGROUND_PAGE) {
		return "event_page";
	}

	return "unknown";
};

/**
 * The contexts that own the router (serve namespaces and accept ports):
 * the Chrome service worker and the Firefox/Safari event page. An
 * explicit `background: true` on createHandler overrides this for
 * custom `background.page` documents.
 */
export const isBackgroundContext = (context: WerpcContext): boolean => context !== "unknown";
