import { InferNamespace } from "werpc";
import { createHandler, pingAll } from "./app";

const namespace = "offscreen";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const handler = createHandler(namespace);

declare module "werpc" {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface WERPCNamespaces extends InferNamespace<typeof handler> {}
}

pingAll(namespace);
