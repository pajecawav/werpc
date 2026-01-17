import { initHandler } from "../../src";
import { initWERPC } from "../../src/werpc";
import { pingAll } from "./ping";

const namespace2 = "kek";

const werpc2 = initWERPC();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const handler2 = initHandler({
	namespace: namespace2,
	router: werpc2.router({
		ping: werpc2.procedure.query(({ ctx }) => `pong from kek ${ctx.tabId}`),
	}),
	debug: true,
});

declare module "../../src/types" {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface WERPCNamespaces extends InferNamespace<typeof handler2> {}
}

pingAll(namespace2);

// initDebugApp("content2");
