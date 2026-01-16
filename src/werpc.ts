import { initTRPC } from "@trpc/server";
import { WERPCContext } from "./context";

export const initWERPC = <TContext extends WERPCContext, TMeta extends object = object>() => {
	return initTRPC
		.context<TContext>()
		.meta<TMeta>()
		.create({ isServer: false, allowOutsideOfServer: true });
};
