import { initTRPC } from "@trpc/server";

export interface WERPCContext {
	tabId?: number;
}

export const initWERPC = <TContext extends WERPCContext, TMeta extends object = object>() => {
	return initTRPC
		.context<TContext>()
		.meta<TMeta>()
		.create({ isServer: false, allowOutsideOfServer: true });
};
