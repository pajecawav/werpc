import browser from "webextension-polyfill";
import { InferNamespace, initHandler, initWERPC } from "werpc";
import { pingAll } from "./ping";

const namespace = "devtools";

const werpc = initWERPC();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const handler = initHandler({
	namespace,
	router: werpc.router({
		ping: werpc.procedure.query(({ ctx }) => `pong from devtools ${ctx.tabId}`),
	}),
	debug: true,
});

declare module "werpc" {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface WERPCNamespaces extends InferNamespace<typeof handler> {}
}

pingAll(namespace);

await browser.devtools.panels.create("werpc", "", "devtoolsPanel.html");
