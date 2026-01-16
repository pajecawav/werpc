import { initHandler } from "../../src";
import { initWERPC } from "../../src/werpc";
import { pingAll } from "./ping";

const namespace = "content";

const werpc = initWERPC();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const handler = initHandler({
	namespace,
	router: werpc.router({
		ping: werpc.procedure.query(({ ctx }) => `pong from content ${ctx.tabId}`),
	}),
	debug: true,
});

declare module "../../src/types" {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface WERPCNamespaces extends InferNamespace<typeof handler> {}
}

pingAll(namespace);

// initDebugApp("content");
