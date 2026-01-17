import { InferNamespace } from "werpc";
import { createHandler, pingAll } from "./app";

const namespace2 = "content2";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const handler2 = createHandler(namespace2);

declare module "werpc" {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface WERPCNamespaces extends InferNamespace<typeof handler2> {}
}

pingAll(namespace2);
