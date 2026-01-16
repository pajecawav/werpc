export const createLogger = (name: string) => {
	const log = (...args: unknown[]) => console.log(`[${name}]`, ...args);

	return { log };
};
