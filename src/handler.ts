import { AnyProcedure, AnyRouter, TRPCError } from "@trpc/server";
import { isObservable, observableToAsyncIterable } from "@trpc/server/observable";
import { isAsyncIterable } from "@trpc/server/unstable-core-do-not-import";
import * as v from "valibot";
import {
	BridgeContext,
	BridgeErrorOutput,
	BridgeEventPayload,
	bridgeRequestSchema,
	BridgeRequest,
} from "./bridge";
import { WERPC_NAMESPACE } from "./constants";
import { detectContext } from "./detect";
import { createIdempotencyKey } from "./idempotency/key";
import { WERPCPort } from "./port";
import { PortLike, router, RoutingHandler } from "./router";
import { WERPCContext } from "./werpc";

export interface CreateHandlerOptions<TNamespace extends string, TRouter extends AnyRouter> {
	namespace: TNamespace;
	router: TRouter;
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
		{ abort: () => void; context: BridgeContext; id: number }
	>();
	private completedSubscriptions = new Map<string, { resendStop: () => void }>();
	private port: WERPCPort | null = null;

	public constructor(private readonly options: CreateHandlerOptions<TNamespace, TRouter>) {
		if (detectContext() === "service_worker") {
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

	private announce = () => {
		this.port?.postMessage({ werpc_announce: { namespace: this.options.namespace } });
	};

	private onPortMessage = async (message: unknown) => {
		const req = v.safeParse(bridgeRequestSchema, message);
		if (!req.success) {
			return;
		}

		const request = req.output.werpc_request;

		if (request.context.namespace !== this.options.namespace) {
			return;
		}

		await this.acceptRequest(request, null);
	};

	public acceptRequest = async (
		request: BridgeRequest["werpc_request"],
		fromPort: PortLike | null,
	) => {
		const target: PortLike = fromPort ?? {
			postMessage: message => this.port?.postMessage(message),
		};
		const tabId = request.context.tabId ?? fromPort?.sender?.tab?.id;

		const sendEvent = (payload: Omit<BridgeEventPayload, "idempotencyKey">) => {
			safePost(target, {
				werpc_event: { ...payload, idempotencyKey: createIdempotencyKey() },
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

	// TODO: force-disconnect ports for keep-alive
	// https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension
	// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port#lifecycle
	// or https://developer.chrome.com/docs/extensions/develop/concepts/service_workers/lifecycle#idle-shutdown (use chrome.runtime.getPlatformInfo every <30 seconds?)
	private addPort = (port: chrome.runtime.Port) => {
		if (port.name !== WERPC_NAMESPACE) {
			return;
		}

		const portLike = port as unknown as PortLike;

		const intervalId = setInterval(() => {
			void chrome.runtime.getPlatformInfo();
		}, 20_000);

		port.onDisconnect.addListener(() => {
			router.forgetPort(portLike);
			clearInterval(intervalId);
		});

		port.onMessage.addListener(message => {
			router.handleMessage(message, portLike);
		});
	};

	private rememberCompleted = (
		requestId: string,
		context: BridgeContext,
		id: number,
		sendEvent: (payload: Omit<BridgeEventPayload, "idempotencyKey">) => void,
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
		sendEvent: (payload: Omit<BridgeEventPayload, "idempotencyKey">) => void;
	}) => {
		const { id, path, input, type } = request;
		const { clientName } = request.context;
		const requestId = `${request.context.clientId}:${request.context.namespace}:${id}`;

		if (type === "subscription.stop") {
			this.subscriptions.get(requestId)?.abort();
			this.subscriptions.delete(requestId);
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
				// duplicate start means the ack was lost (e.g. the client retried):
				// re-send the ack instead of subscribing twice
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

			this.subscriptions.set(requestId, { abort: () => ac.abort(), context, id });

			sendEvent({
				context,
				id,
				type: "subscription.ack",
				output: {},
			});

			for await (const chunk of iterable) {
				sendEvent({
					context,
					id,
					type: "subscription.output",
					output: chunk,
				});
			}

			this.subscriptions.delete(requestId);
			this.rememberCompleted(requestId, context, id, sendEvent);

			sendEvent({
				context,
				id,
				type: "subscription.stop",
				output: {},
			});
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
}: CreateHandlerOptions<TNamespace, TRouter>): WERPCHandler<TNamespace, TRouter> => {
	return new WERPCHandler({ namespace: handlerNamespace, router: handlerRouter });
};
