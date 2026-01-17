import { TRPCLink } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { BridgeRequest } from "../bridge";
import { EventEmitter } from "../events";
import { createIdempotencyKey } from "../idempotency/key";

/** namespace:id */
type NamespacedKey = `${string}:${number}`;

export type LinkEvents = {
	[Key in `${NamespacedKey}:event`]: [data: unknown];
} & {
	[Key in `${NamespacedKey}:sub_ack`]: [];
};

interface CreateWERPCLinkOptions {
	clientId: string;
	namespace: string;
	postMessage: (request: BridgeRequest) => void;
	events: EventEmitter<LinkEvents>;
}

export type WERPCLink = TRPCLink<AnyRouter>;

export const createWERPCLink = ({
	clientId,
	namespace,
	postMessage,
	events,
}: CreateWERPCLinkOptions): WERPCLink => {
	return () =>
		({ op }) => {
			return observable(observer => {
				const { id, path, input, type, signal } = op;

				const namespacedKey: NamespacedKey = `${namespace}:${id}`;

				const unsubscribe = events.on(`${namespacedKey}:event`, data => {
					observer.next({ result: { data } });

					if (type !== "subscription") {
						observer.complete();
						// unsubscribe();
					}
				});

				const common = { clientId, namespace, id, path, input };

				signal?.addEventListener("abort", () => {
					unsubscribe();

					postMessage({
						werpc_request: {
							...common,
							idempotencyKey: createIdempotencyKey(),
							type: "subscription.stop",
						},
					} satisfies BridgeRequest);
				});

				switch (type) {
					case "subscription": {
						events.once(`${namespacedKey}:sub_ack`, () => {
							clearTimeout(timeoutId);
							observer.next({ result: { type: "started" } });
						});

						let timeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

						(function subscribe() {
							postMessage({
								werpc_request: {
									...common,
									idempotencyKey: createIdempotencyKey(),
									type: "subscription.start",
								},
							});

							timeoutId = setTimeout(subscribe, 1000);
						})();

						break;
					}

					case "query":
					case "mutation":
						postMessage({
							werpc_request: {
								...common,
								idempotencyKey: createIdempotencyKey(),
								type,
							},
						});

						break;
				}

				return () => {
					observer.complete();
				};
			});
		};
};
