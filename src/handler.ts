import { AnyProcedure, AnyRouter } from "@trpc/server";
import { isObservable, observableToAsyncIterable } from "@trpc/server/observable";
import { isAsyncIterable } from "@trpc/server/unstable-core-do-not-import";
import * as v from "valibot";
import browser from "webextension-polyfill";
import {
	BridgeContext,
	BridgeEvent,
	BridgeEventPayload,
	bridgeEventSchema,
	BridgeRequest,
	bridgeRequestSchema,
} from "./bridge";
import { WERPC_NAMESPACE } from "./constants";
import { detectContext } from "./detect";
import { createIdempotencyKey } from "./idempotency/key";
import { IdempotencyManager } from "./idempotency/manager";
import { WERPCPort } from "./port";
import { WERPCContext } from "./werpc";

interface PortLike {
	postMessage(message: unknown): void;
	sender?: browser.Runtime.MessageSender;
}

export interface CreateHandlerOptions<TNamespace extends string, TRouter extends AnyRouter> {
	namespace: TNamespace;
	router: TRouter;
	debug?: boolean;
}

export interface WERPCHandler<TNamespace extends string, TRouter extends AnyRouter> {
	namespace: TNamespace;
	router: TRouter;
}

// TODO: rewrite this clusterfuck to a class
export const createHandler = <TNamespace extends string, TRouter extends AnyRouter>({
	namespace: handlerNamespace,
	router,
	// debug,
}: CreateHandlerOptions<TNamespace, TRouter>): WERPCHandler<TNamespace, TRouter> => {
	// const logger = createLogger(`[WERPC-HANDLER] [${handlerNamespace}]`, debug);

	const ports = new Set<PortLike>();

	const idempotencyManager = new IdempotencyManager();

	const subscriptions = new Map<string, VoidFunction>();

	if (detectContext() !== "service_worker") {
		const werpcPort = WERPCPort.getInstance();
		ports.add(werpcPort);

		werpcPort.onMessage((message, sender) => {
			void onMessage(message, sender);

			return "ack";
		});
	}

	// TODO: broadcasting should be a part of WERPCPort?
	/*
	 * Broadcast message to connected ports
	 */
	const broadcast = (request: BridgeRequest | BridgeEvent, targetTabId: number | undefined) => {
		// if (detectContext() === "service_worker") {
		for (const p of ports) {
			const noTargetTab = targetTabId === undefined;
			const portTabId = p.sender?.tab?.id;
			const isTargetTab = portTabId === targetTabId;

			if (noTargetTab || !portTabId || isTargetTab) {
				p.postMessage(request);
			}
		}
		// } else {
		// 	WERPCPort.getInstance().postMessage(request);
		// }
	};

	const onMessage = async (
		message: unknown,
		sender: browser.Runtime.MessageSender | undefined,
	) => {
		const ev = v.safeParse(bridgeEventSchema, message);
		if (ev.success) {
			if (!idempotencyManager.isDuplicate(ev.output.werpc_event.idempotencyKey)) {
				ev.output.werpc_event.context.tabId ??= sender?.tab?.id;
				broadcast(
					ev.output,
					ev.output.werpc_event.context.scopeToTab
						? ev.output.werpc_event.context.tabId
						: undefined,
				);
			}
			return;
		}

		const req = v.safeParse(bridgeRequestSchema, message);
		if (!req.success) {
			return;
		}

		if (idempotencyManager.isDuplicate(req.output.werpc_request.idempotencyKey)) {
			return;
		}

		const { context, id, path, type, input } = req.output.werpc_request;
		const { clientId, clientName, namespace: requestNamespace, scopeToTab } = context;

		const tabId = context.tabId ?? sender?.tab?.id;
		const targetTabId = scopeToTab ? tabId : undefined;

		if (requestNamespace !== handlerNamespace) {
			req.output.werpc_request.context.tabId = tabId;
			broadcast(req.output, targetTabId);

			return;
		}

		const sendEvent = (payload: BridgeEventPayload) => {
			broadcast({ werpc_event: payload }, targetTabId);
		};

		const requestId = `${clientId}:${requestNamespace}:${id}`;

		if (type === "subscription.stop") {
			subscriptions.get(requestId)?.();
			subscriptions.delete(requestId);
			return;
		}

		const ac = new AbortController();

		const ctx: WERPCContext = { clientName, tabId };
		const caller = router.createCaller(ctx, { signal: ac.signal });
		const handler = path
			.split(".")
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
			.reduce((c, segment) => c[segment], caller as any) as AnyProcedure;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
		const output = await handler(input as any);

		if (type === "subscription.start") {
			if (subscriptions.has(requestId)) {
				throw new Error(`Duplicate subscription with id ${requestId}`);
			}

			if (!isAsyncIterable(output) && !isObservable(output)) {
				throw new Error(`Expected an observable or async iterable, got ${typeof output}`);
			}

			const iterable = isObservable(output)
				? observableToAsyncIterable(output, ac.signal)
				: output;

			subscriptions.set(requestId, () => ac.abort());

			const context: BridgeContext = {
				clientId,
				clientName,
				namespace: handlerNamespace,
				tabId,
				scopeToTab,
			};

			sendEvent({
				idempotencyKey: createIdempotencyKey(),
				context,
				id,
				type: "subscription.ack",
				output: {},
			});

			for await (const chunk of iterable) {
				sendEvent({
					idempotencyKey: createIdempotencyKey(),
					context,
					id,
					type: "subscription.output",
					output: chunk,
				});
			}

			sendEvent({
				idempotencyKey: createIdempotencyKey(),
				context,
				id,
				type: "subscription.stop",
				output: {},
			});
		} else {
			sendEvent({
				idempotencyKey: createIdempotencyKey(),
				context,
				id,
				type: "output",
				output,
			});
		}
	};

	// TODO: force-disconnect ports for keep-alive
	// https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension
	// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port#lifecycle
	browser.runtime.onConnect.addListener(port => {
		if (port.name !== WERPC_NAMESPACE) {
			return;
		}

		ports.add(port);

		port.onDisconnect.addListener(() => {
			ports.delete(port);
		});

		port.onMessage.addListener(message => {
			void onMessage(message, port.sender);

			return "ack";
		});
	});

	return { namespace: handlerNamespace, router };
};
