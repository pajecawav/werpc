export const detectContext = () => {
	if (
		// @ts-expect-error TS-2304
		typeof ServiceWorkerGlobalScope !== "undefined" &&
		// @ts-expect-error TS-2304
		self instanceof ServiceWorkerGlobalScope
	) {
		return "service_worker";
	}

	return "unknown";
};
