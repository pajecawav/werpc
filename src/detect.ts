export const detectContext = () => {
	// Service worker
	if (
		// @ts-expect-error TS-2304
		typeof ServiceWorkerGlobalScope !== "undefined" &&
		// @ts-expect-error TS-2304
		self instanceof ServiceWorkerGlobalScope
	) {
		return "service_worker";
	}

	// // Not an extension at all (web page)
	// if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
	// 	return "web_page";
	// }

	// // Extension pages (popup, options, devtools)
	// if (typeof window !== "undefined" && typeof document !== "undefined" && chrome.tabs) {
	// 	return "extension_page";
	// }

	// // Content script
	// return "content_script";

	return "unknown";
};
