import { InferNamespace } from "werpc";
import { createHandler, pingAll } from "./app";

await chrome.offscreen.createDocument({
	url: "offscreen.html",
	reasons: ["CLIPBOARD"],
	justification: "reason for needing the document",
});

const namespace = "background";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const handler = createHandler(namespace);

declare module "werpc" {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface WERPCNamespaces extends InferNamespace<typeof handler> {}
}

pingAll(namespace);
