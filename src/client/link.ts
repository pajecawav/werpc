import { TRPCLink } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { BridgeEventPayload, BridgeRequest } from "../bridge";
import { EventEmitter } from "../events";
import { createIdempotencyKey } from "../idempotency/key";
import { expectNever } from "../utils";

/** namespace:id */
type NamespacedKey = `${string}:${number}`;

export type LinkEvents = {
	[Key in NamespacedKey]: [event: BridgeEventPayload];
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

				let subscriptionTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

				const unsubscribe = events.on(namespacedKey, event => {
					switch (event.type) {
						case "output":
							observer.next({ result: { data: event.output } });
							observer.complete();
							break;

						case "subscription.ack":
							clearTimeout(subscriptionTimeoutId);
							observer.next({ result: { type: "started" } });
							break;

						case "subscription.output":
							observer.next({ result: { data: event.output } });
							break;

						case "subscription.stop":
							unsubscribe();
							observer.complete();
							break;

						default:
							expectNever(event.type);
					}
				});

				switch (type) {
					case "subscription": {
						(function subscribe() {
							postMessage({
								werpc_request: {
									...common,
									idempotencyKey: createIdempotencyKey(),
									type: "subscription.start",
								},
							});

							subscriptionTimeoutId = setTimeout(subscribe, 1000);
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

					default:
						expectNever(type);
				}

				return () => {
					// observer.complete();
					postMessage({
						werpc_request: {
							...common,
							idempotencyKey: createIdempotencyKey(),
							type: "subscription.stop",
						},
					} satisfies BridgeRequest);
				};
			});
		};
};
