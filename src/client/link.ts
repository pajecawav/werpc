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
	"clientId" | "clientName" | "namespace" | "scopeToTab" | "tabId" | "fanout"
> {
	postRequest: (request: BridgeRequest) => void;
	events: EventEmitter<LinkEvents>;
	/** Fail queries/mutations after this long (ms); 0 disables. */
	timeoutMs: number;
	/** Subscribe to port reconnects; returns the unsubscribe function. */
	onPortReconnect: (cb: () => void) => VoidFunction;
}

export type WERPCLink = TRPCLink<AnyRouter>;

export const createWERPCLink = ({
	clientId,
	clientName,
	tabId,
	scopeToTab,
	fanout,
	namespace,
	postRequest,
	events,
	timeoutMs,
	onPortReconnect,
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
						fanout,
					} satisfies BridgeContext,
					id,
					path,
					input,
				};

				const cleanup = () => {
					clearTimers();
					unsubscribe();
					offReconnect?.();
					finished = true;

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
				/** Set once the op is over (output/error/stop/unsubscribed):
				 * a reconnect must not resurrect it. */
				let finished = false;
				/** Suppresses duplicate `started` signals on re-acks. */
				let startedSent = false;
				/** Whether the stream is considered started (ack or data
				 * seen) — a reconnect re-kicks only such settled ops. */
				let acked = false;
				let offReconnect: VoidFunction | undefined = undefined;

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
							finished = true;
							clearTimers();
							observer.next({ result: { data: event.output } });
							observer.complete();
							break;

						case "subscription.ack":
							acked = true;
							clearTimeout(subscriptionTimeoutId);
							if (!startedSent) {
								startedSent = true;
								observer.next({ result: { type: "started" } });
							}
							break;

						case "error": {
							finished = true;
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
							acked = true;
							clearTimeout(subscriptionTimeoutId);
							observer.next({ result: { data: event.output } });
							break;

						case "subscription.stop":
							finished = true;
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

						const subscribe = () => {
							if (finished) {
								return;
							}
							postRequest({
								werpc_request: {
									...common,
									v: PROTOCOL_VERSION,
									type: "subscription.start",
								},
							});

							// retry until the ack arrives; survives SW/event-page
							// restarts and lost acks (the handler re-acks duplicate
							// starts)
							subscriptionTimeoutId = setTimeout(
								subscribe,
								RETRY_STEPS[Math.min(retryIndex, RETRY_STEPS.length - 1)] ??
									RETRY_STEPS[2],
							);
							retryIndex++;
						};

						// A hub restart drops this client's port mapping; once the
						// port reconnects, a live (already acked) subscription must
						// announce itself again — the retry loop has stopped by
						// then. The handler re-acks a start it still holds or
						// spins up a fresh stream; either way outputs resume.
						offReconnect = onPortReconnect(() => {
							if (finished || !acked) {
								return; // over, or the retry loop is still running
							}
							acked = false;
							retryIndex = 0;
							subscribe();
						});

						subscribe();

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
