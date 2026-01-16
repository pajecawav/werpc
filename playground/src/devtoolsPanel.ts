import { initHandler, initWERPC } from "../../src";
import { pingAll } from "./ping";

const namespace = "devtoolsPanel";

const werpc = initWERPC();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const handler = initHandler({
	namespace,
	router: werpc.router({
		ping: werpc.procedure.query(({ ctx }) => `pong from devtoolsPanel ${ctx.tabId}`),
	}),
	debug: true,
});

declare module "../../src/types" {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface WERPCNamespaces extends InferNamespace<typeof handler> {}
}

pingAll(namespace);

// initDebugApp("devtoolsPanel");
