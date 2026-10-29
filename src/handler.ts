import { AnyProcedure, AnyRouter, TRPCError } from "@trpc/server";
import { isObservable, observableToAsyncIterable } from "@trpc/server/observable";
import { isAsyncIterable } from "@trpc/server/unstable-core-do-not-import";
import {
	BridgeContext,
	BridgeErrorOutput,
	BridgeEventPayload,
	isBridgeDrop,
	isBridgeRequest,
	BridgeRequest,
	PROTOCOL_VERSION,
} from "./bridge";
import { WERPC_NAMESPACE } from "./constants";
import { detectContext, isBackgroundContext } from "./detect";
import { acquireKeepAlive, releaseKeepAlive } from "./keep-alive";
import { WERPCPort } from "./port";
import { PortLike, router, RoutingHandler } from "./router";
import { WERPCContext } from "./werpc";

export interface CreateHandlerOptions<TNamespace extends string, TRouter extends AnyRouter> {
	namespace: TNamespace;
	router: TRouter;
	/**
	 * Explicit tab id for contexts whose port has no sender tab
	 * (devtools panels, offscreen documents). Enables tab-scoped and
	 * fan-out routing to this handler.
	 */
	tabId?: number;
	/**
	 * Force server behavior (own the router, accept ports) regardless of
	 * context detection. For custom `background.page` documents, whose
	 * path the generated-page detection cannot see.
	 */
	background?: boolean;
}

const safePost = (port: PortLike, message: unknown) => {
	try {
		port.postMessage(message);
		return true;
	} catch {
		return false;
	}
};

/** How long a finished subscription remembers its id to swallow duplicate starts. */
const COMPLETED_SUBSCRIPTION_TTL_MS = 5_000;

const describeError = (error: unknown, path: string): BridgeErrorOutput => {
	if (error instanceof TRPCError) {
		return { message: error.message, code: error.code, path };
	}

	const message = error instanceof Error ? error.message : String(error);

	return { message, code: "INTERNAL_SERVER_ERROR", path };
};

export class WERPCHandler<
	TNamespace extends string,
	TRouter extends AnyRouter,
> implements RoutingHandler {
	private subscriptions = new Map<
		string,
		{
			close: () => void;
			context: BridgeContext;
			id: number;
			/** Refreshed on every re-ack: after a reconnect the stream must
			 * flow through the port the latest request arrived on. */
			route: (payload: Omit<BridgeEventPayload, "v">) => void;
		}
	>();
	private completedSubscriptions = new Map<string, { resendStop: () => void }>();
	private port: WERPCPort | null = null;
	private readonly isBackground: boolean;

	public constructor(private readonly options: CreateHandlerOptions<TNamespace, TRouter>) {
		this.isBackground = options.background === true || isBackgroundContext(detectContext());

		if (this.isBackground) {
			router.registerLocal(options.namespace, this);
			chrome.runtime.onConnect.addListener(this.addPort);
		} else {
			this.port = new WERPCPort();
			this.port.onMessage(message => {
				void this.onPortMessage(message);
			});
			this.port.onReconnect(this.announce);
			this.announce();
		}
	}

	/** Stop serving the namespace and release all resources. */
	public dispose = () => {
		if (this.isBackground) {
			router.unregisterLocal(this.options.namespace, this);
			chrome.runtime.onConnect.removeListener(this.addPort);
		} else {
			this.port?.close();
			this.port = null;
		}

		for (const requestId of this.subscriptions.keys()) {
			this.closeSubscription(requestId);
		}
	};

	private announce = () => {
		this.port?.postMessage({
			werpc_announce: {
				v: PROTOCOL_VERSION,
				namespace: this.options.namespace,
				tabId: this.options.tabId,
			},
		});
	};

	private onPortMessage = async (message: unknown) => {
		if (isBridgeDrop(message)) {
			this.dropClient(message.werpc_drop.clientId);
			return;
		}

		if (!isBridgeRequest(message)) {
			return;
		}

		const request = message.werpc_request;

		if (request.context.namespace !== this.options.namespace) {
			return;
		}

		await this.acceptRequest(request, null);
	};

	public dropClient = (clientId: string) => {
		const prefix = `${clientId}:`;

		for (const requestId of this.subscriptions.keys()) {
			if (requestId.startsWith(prefix)) {
				this.closeSubscription(requestId);
			}
		}
	};

	private closeSubscription = (requestId: string) => {
		const subscription = this.subscriptions.get(requestId);

		if (!subscription) {
			return;
		}

		this.subscriptions.delete(requestId);
		subscription.close();
	};

	public acceptRequest = async (
		request: BridgeRequest["werpc_request"],
		fromPort: PortLike | null,
	) => {
		const target: PortLike = fromPort ?? {
			postMessage: message => this.port?.postMessage(message),
		};
		const tabId = request.context.tabId ?? fromPort?.sender?.tab?.id;

		const sendEvent = (payload: Omit<BridgeEventPayload, "v">) => {
			safePost(target, {
				werpc_event: { ...payload, v: PROTOCOL_VERSION },
			});
		};

		try {
			await this.handleRequest({ request, tabId, sendEvent });
		} catch (error) {
			sendEvent({
				context: {
					...request.context,
					namespace: this.options.namespace,
					tabId,
				},
				id: request.id,
				type: "error",
				output: describeError(error, request.path),
			});
		}
	};

	private addPort = (port: chrome.runtime.Port) => {
		if (port.name !== WERPC_NAMESPACE) {
			return;
		}

		const portLike = port as unknown as PortLike;

		port.onDisconnect.addListener(() => {
			router.forgetPort(portLike);
		});

		port.onMessage.addListener(message => {
			router.handleMessage(message, portLike);
		});
	};

	private rememberCompleted = (
		requestId: string,
		context: BridgeContext,
		id: number,
		sendEvent: (payload: Omit<BridgeEventPayload, "v">) => void,
	) => {
		this.completedSubscriptions.set(requestId, {
			resendStop: () => {
				sendEvent({
					context,
					id,
					type: "subscription.stop",
					output: {},
				});
			},
		});

		setTimeout(() => {
			this.completedSubscriptions.delete(requestId);
		}, COMPLETED_SUBSCRIPTION_TTL_MS);
	};

	private processRequest = async ({
		clientName,
		tabId,
		path,
		input,
		signal,
	}: {
		clientName?: string;
		tabId?: number;
		path: string;
		input: unknown;
		signal: AbortSignal;
	}) => {
		const ctx: WERPCContext = { clientName, tabId };
		const caller = this.options.router.createCaller(ctx, { signal });
		const procedure = this.resolveProcedure(caller, path);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return
		return await procedure(input as any);
	};

	private resolveProcedure = (caller: unknown, path: string): AnyProcedure => {
		const procedure = path.split(".").reduce<unknown>((node, segment) => {
			const callable = typeof node === "function";
			const indexable = typeof node === "object" && node !== null;

			if (!callable && !indexable) {
				return undefined;
			}

			return (node as Record<string, unknown>)[segment];
		}, caller);

		if (typeof procedure !== "function") {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Procedure not found: ${path}`,
			});
		}

		return procedure as AnyProcedure;
	};

	private handleRequest = async ({
		request,
		tabId,
		sendEvent,
	}: {
		request: BridgeRequest["werpc_request"];
		tabId: number | undefined;
		sendEvent: (payload: Omit<BridgeEventPayload, "v">) => void;
	}) => {
		const { id, path, input, type } = request;
		const { clientName } = request.context;
		const requestId = `${request.context.clientId}:${request.context.namespace}:${id}`;

		if (type === "subscription.stop") {
			this.closeSubscription(requestId);
			return;
		}

		const ac = new AbortController();

		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const output = await this.processRequest({
			clientName,
			tabId,
			path,
			input,
			signal: ac.signal,
		});

		if (type === "subscription.start") {
			const completed = this.completedSubscriptions.get(requestId);

			if (completed) {
				// duplicate start for a subscription that already finished:
				// re-send the stop event instead of running the generator again
				completed.resendStop();
				return;
			}

			const existing = this.subscriptions.get(requestId);

			if (existing) {
				// duplicate start means the ack was lost (e.g. the client
				// retried, or it reconnected after a hub restart and its
				// live subscription announced itself again): re-ack, and
				// refresh the output route — the stream's captured port may
				// be dead, the one this request arrived on is not
				existing.route = sendEvent;
				sendEvent({
					context: existing.context,
					id: existing.id,
					type: "subscription.ack",
					output: {},
				});
				return;
			}

			if (!isAsyncIterable(output) && !isObservable(output)) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Expected an observable or async iterable, got ${typeof output}`,
				});
			}

			const iterable = isObservable(output)
				? observableToAsyncIterable(output, ac.signal)
				: output;

			const context: BridgeContext = {
				...request.context,
				namespace: this.options.namespace,
				tabId,
			};

			const entry = {
				close: () => {
					ac.abort();
					releaseKeepAlive();
				},
				context,
				id,
				route: sendEvent,
			};

			acquireKeepAlive();
			this.subscriptions.set(requestId, entry);

			sendEvent({
				context,
				id,
				type: "subscription.ack",
				output: {},
			});

			try {
				for await (const chunk of iterable) {
					entry.route({
						context,
						id,
						type: "subscription.output",
						output: chunk,
					});
				}
			} catch (error) {
				// The generator threw: release the entry (and keep-alive) but
				// send no stop and leave no tombstone — the error report the
				// caller sends is the client's end-of-stream signal.
				if (this.subscriptions.get(requestId) === entry) {
					this.closeSubscription(requestId);
				}
				throw error;
			}

			// Finish only if we still own the requestId: a dropClient or
			// a re-start may have removed/replaced us — then our abort
			// must leave no completion tombstone and no stop event that
			// would kill the successor stream on the client.
			if (this.subscriptions.get(requestId) === entry) {
				this.closeSubscription(requestId);
				this.rememberCompleted(requestId, context, id, entry.route);

				entry.route({
					context,
					id,
					type: "subscription.stop",
					output: {},
				});
			}
		} else {
			sendEvent({
				context: {
					...request.context,
					namespace: this.options.namespace,
					tabId,
				},
				id,
				type: "output",
				output,
			});
		}
	};
}

export const createHandler = <TNamespace extends string, TRouter extends AnyRouter>({
	namespace: handlerNamespace,
	router: handlerRouter,
	tabId: handlerTabId,
	background: handlerBackground,
}: CreateHandlerOptions<TNamespace, TRouter>): WERPCHandler<TNamespace, TRouter> => {
	return new WERPCHandler({
		namespace: handlerNamespace,
		router: handlerRouter,
		tabId: handlerTabId,
		background: handlerBackground,
	});
};
