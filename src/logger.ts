export const createLogger = (prefix: string, debug = false) => {
	const logger = {
		debug: (...args: unknown[]) => (debug ? console.log(prefix, ...args) : undefined),
		log: (...args: unknown[]) => console.log(prefix, ...args),
		info: (...args: unknown[]) => console.info(prefix, ...args),
		warn: (...args: unknown[]) => console.warn(prefix, ...args),
		error: (...args: unknown[]) => console.error(prefix, ...args),
	};

	return logger;
};

export type Logger = ReturnType<typeof createLogger>;
