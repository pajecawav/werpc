import { TRPCClientError, TRPCLink } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import {
	BridgeContext,
	BridgeErrorOutput,
	BridgeEventPayload,
	BridgeRequest,
	PROTOCOL_VERSION,
} from "../bridge";
import { EventEmitter } from "../events";
import { expectNever } from "../utils";

/** namespace:id */
type NamespacedKey = `${string}:${number}`;

export type LinkEvents = {
	[Key in NamespacedKey]: [event: BridgeEventPayload];
};

interface CreateWERPCLinkOptions extends Pick<
	BridgeContext,
	"clientId" | "clientName" | "namespace" | "scopeToTab" | "tabId"
> {
	postRequest: (request: BridgeRequest) => void;
	events: EventEmitter<LinkEvents>;
	/** Fail queries/mutations after this long (ms); 0 disables. */
	timeoutMs: number;
}

export type WERPCLink = TRPCLink<AnyRouter>;

export const createWERPCLink = ({
	clientId,
	clientName,
	tabId,
	scopeToTab,
	namespace,
	postRequest,
	events,
	timeoutMs,
}: CreateWERPCLinkOptions): WERPCLink => {
	return () =>
		({ op }) => {
			return observable(observer => {
				const { id, path, input, type, signal } = op;

				const common = {
					context: {
						clientId,
						clientName,
						namespace,
						tabId,
						scopeToTab,
					} satisfies BridgeContext,
					id,
					path,
					input,
				};

				const cleanup = () => {
					clearTimers();
					unsubscribe();

					if (type === "subscription") {
						postRequest({
							werpc_request: {
								...common,
								v: PROTOCOL_VERSION,
								type: "subscription.stop",
							},
						} satisfies BridgeRequest);
					}
				};

				signal?.addEventListener("abort", () => {
					cleanup();
				});

				let subscriptionTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;
				let opTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

				const clearTimers = () => {
					clearTimeout(subscriptionTimeoutId);
					clearTimeout(opTimeoutId);
				};

				if (timeoutMs > 0 && (type === "query" || type === "mutation")) {
					opTimeoutId = setTimeout(() => {
						cleanup();
						observer.error(
							new TRPCClientError(`werpc: ${type} timed out after ${timeoutMs}ms`, {
								meta: { code: "TIMEOUT", message: "timeout" },
							}),
						);
					}, timeoutMs);
				}

				const unsubscribe = events.on(`${namespace}:${id}`, event => {
					switch (event.type) {
						case "output":
							clearTimers();
							observer.next({ result: { data: event.output } });
							observer.complete();
							break;

						case "subscription.ack":
							clearTimeout(subscriptionTimeoutId);
							observer.next({ result: { type: "started" } });
							break;

						case "error": {
							const error = event.output as BridgeErrorOutput;
							clearTimers();
							unsubscribe();
							observer.error(
								new TRPCClientError(error.message, {
									meta: { code: error.code, message: error.message },
								}),
							);
							break;
						}

						case "subscription.output":
							// data proves the subscription started even if the ack was lost
							clearTimeout(subscriptionTimeoutId);
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
						const RETRY_STEPS = [1000, 2000, 5000] as const;
						let retryIndex = 0;

						(function subscribe() {
							postRequest({
								werpc_request: {
									...common,
									v: PROTOCOL_VERSION,
									type: "subscription.start",
								},
							});

							// retry until the ack arrives; survives SW restarts and
							// lost acks (the handler re-acks duplicate starts)
							subscriptionTimeoutId = setTimeout(
								subscribe,
								RETRY_STEPS[Math.min(retryIndex, RETRY_STEPS.length - 1)] ??
									RETRY_STEPS[2],
							);
							retryIndex++;
						})();

						break;
					}

					case "query":
					case "mutation":
						postRequest({
							werpc_request: {
								...common,
								v: PROTOCOL_VERSION,
								type,
							},
						});

						break;

					default:
						expectNever(type);
				}

				return () => {
					cleanup();
				};
			});
		};
};
