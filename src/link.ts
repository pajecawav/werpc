import { TRPCLink } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { BridgeRequest } from "./bridge";
import { createIdempotencyKey } from "./key";

interface CreateWERPCLinkOptions {
	namespace: string;
	postMessage: (request: BridgeRequest) => void;
	listeners: Map<string, (result: unknown) => void>;
}

export type WERPCLink = TRPCLink<AnyRouter>;

export const createWERPCLink = ({
	namespace,
	postMessage,
	listeners,
}: CreateWERPCLinkOptions): WERPCLink => {
	return () =>
		({ op }) => {
			return observable(observer => {
				const { id, path, input, type, signal } = op;

				const listenerKey = `${namespace}:${id}`;

				listeners.set(listenerKey, data => {
					observer.next({ result: { data } });

					if (type !== "subscription") {
						observer.complete();
					}
				});

				signal?.addEventListener("abort", () => {
					listeners.delete(listenerKey);
					// observer.next({ result: { type: "stopped" } });
					postMessage({
						werpc_request: {
							namespace,
							idempotencyKey: createIdempotencyKey(),
							id,
							path,
							input,
							type: "subscription.stop",
						},
					} satisfies BridgeRequest);
				});

				let request: BridgeRequest;
				if (type === "subscription") {
					request = {
						werpc_request: {
							namespace,
							idempotencyKey: createIdempotencyKey(),
							id,
							path,
							input,
							type: "subscription.start",
						},
					};
					observer.next({ result: { type: "started" } });
				} else {
					request = {
						werpc_request: {
							namespace,
							idempotencyKey: createIdempotencyKey(),
							id,
							path,
							input,
							type,
						},
					};
				}

				postMessage(request);

				return () => {
					observer.complete();
				};
			});
		};
};
