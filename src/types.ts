import { WERPCHandler } from "./handler";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WERPCNamespaces {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InferNamespace<THandler extends WERPCHandler<any, any>> =
	THandler extends WERPCHandler<infer TNamespace, infer TRouter>
		? { [key in TNamespace]: TRouter }
		: never;

declare const test: WERPCNamespaces;

console.log(test.background.ping());
