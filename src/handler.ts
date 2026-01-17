import { AnyProcedure, AnyRouter } from "@trpc/server";
import { isObservable, observableToAsyncIterable } from "@trpc/server/observable";
import { isAsyncIterable } from "@trpc/server/unstable-core-do-not-import";
import * as v from "valibot";
import browser from "webextension-polyfill";
import {
	BridgeEvent,
	BridgeEventPayload,
	bridgeEventSchema,
	BridgeRequest,
	bridgeRequestSchema,
} from "./bridge";
import { IDEMPOTENCY_KEY_TTL_MS, WERPC_NAMESPACE } from "./constants";
import { WERPCContext } from "./context";
import { createIdempotencyKey } from "./key";
import { createLogger } from "./logger";
import { WERPCPort } from "./port";
import { detectContext } from "./detect";
// import { portManager } from "./portManager";

interface PortLike {
	postMessage(message: unknown): void;
}

interface InitHandlerOptions<TNamespace extends string, TRouter extends AnyRouter> {
	namespace: TNamespace;
	router: TRouter;
	debug?: boolean;
}

export interface WERPCHandler<TNamespace extends string, TRouter extends AnyRouter> {
	namespace: TNamespace;
	router: TRouter;
}

let nextPortId = 1;

export const initHandler = <TNamespace extends string, TRouter extends AnyRouter>({
	namespace,
	router,
	debug,
}: InitHandlerOptions<TNamespace, TRouter>): WERPCHandler<TNamespace, TRouter> => {
	const logger = createLogger(`[WERPC-HANDLER] [${namespace}]`, debug);

	const ports = new Set<PortLike>();

	const seenIdempotencyKeys = new Set<string>();

	// TODO: keys should include namespace and probably port id???
	const subscriptions = new Map<string, VoidFunction>();

	// TODO: для работы content скриптов тут надо ещё слушать browser.tabs.onMessage
	// или сделать общий PortManager который будет всегда коннектиться и переиспользовать его в client/handler
	browser.runtime.onMessage.addListener((message => {
		logger.debug("DIRECT message received", message);
	}) satisfies browser.Runtime.OnMessageListenerNoResponse);

	// ports.add(browser.runtime.connect({ name: WERPC_NAMESPACE }));
	// ports.add(portManager.port);
	// portManager.onPortChanged((newPort, prevPort) => {
	// 	ports.add(newPort);
	// 	ports.delete(prevPort);
	// });

	if (detectContext() !== "service_worker") {
		const werpcPort = WERPCPort.getInstance();
		ports.add(werpcPort);

		werpcPort.onMessage((message, sender) => {
			void onMessage(message, werpcPort, sender);

			return "ack";
		});
	}

	/*
	 * Broadcast message to connected ports
	 */
	const broadcastRequest = (
		request: BridgeRequest | BridgeEvent,
		// tabId?: number
	) => {
		logger.debug(`broadcasting`, request, ports.size);
		for (const p of ports) {
			// TODO: resend to options?
			// if (
			// 	p !== port
			// 	// && p.sender?.tab?.id === tabId
			// 	// && p.sender?.url?.startsWith("chrome-extension://")
			// ) {
			void p.postMessage(request);
			// }
		}

		// if (tabId) {
		// 	// broadcast to content scripts in the same tab
		// 	logger.debug(`broadcasting to tab ${tabId}`, request);
		// 	void browser.tabs.sendMessage(tabId, request);
		// }
	};

	const onMessage = async (
		message: unknown,
		port: PortLike,
		sender: browser.Runtime.MessageSender | undefined,
	) => {
		logger.debug("port message received", message);

		const ev = v.safeParse(bridgeEventSchema, message);
		if (ev.success) {
			const idempotencyKey = ev.output.werpc_event.idempotencyKey;
			if (seenIdempotencyKeys.has(idempotencyKey)) {
				logger.debug("skipping duplicate message", message);
				return;
			}
			seenIdempotencyKeys.add(idempotencyKey);
			setTimeout(() => seenIdempotencyKeys.delete(idempotencyKey), IDEMPOTENCY_KEY_TTL_MS);
			broadcastRequest(ev.output);
			return;
		}

		const req = v.safeParse(bridgeRequestSchema, message);
		if (!req.success) {
			return;
		}

		const tabId = sender?.tab?.id;

		logger.debug("handling message", message);

		const {
			idempotencyKey,
			namespace: _namespace,
			id,
			path,
			type,
			input,
		} = req.output.werpc_request;

		if (seenIdempotencyKeys.has(idempotencyKey)) {
			logger.debug("skipping duplicate message", message);
			return;
		}
		seenIdempotencyKeys.add(idempotencyKey);
		setTimeout(() => seenIdempotencyKeys.delete(idempotencyKey), IDEMPOTENCY_KEY_TTL_MS);

		if (_namespace !== namespace) {
			broadcastRequest(req.output /* tabId */);

			return;
		}

		const sendEvent = (payload: BridgeEventPayload) => {
			// TODO: this should broadcast to all ports?
			logger.debug("SENDING EVENT", payload);
			const event: BridgeEvent = { werpc_event: payload };
			// port.postMessage(event);
			broadcastRequest(event);
		};

		const requestId = id.toString();

		if (type === "subscription.stop") {
			subscriptions.get(requestId)?.();
			subscriptions.delete(requestId);
			return;
		}

		const ac = new AbortController();

		const ctx: WERPCContext = { tabId };
		const caller = router.createCaller(ctx, { signal: ac.signal });
		const handler = path
			.split(".")
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
			.reduce((c, segment) => c[segment], caller as any) as AnyProcedure;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
		const output = await handler(input as any);

		if (type === "subscription.start") {
			if (subscriptions.has(requestId)) {
				throw new Error(`Duplicate subscription with id ${id}`);
			}

			if (!isAsyncIterable(output) && !isObservable(output)) {
				throw new Error(`Expected an observable or async iterable, got ${typeof output}`);
			}

			const iterable = isObservable(output)
				? observableToAsyncIterable(output, ac.signal)
				: output;

			subscriptions.set(requestId, () => ac.abort());

			for await (const chunk of iterable) {
				sendEvent({
					idempotencyKey: createIdempotencyKey(),
					namespace,
					id,
					type: "subscription.output",
					output: chunk,
				});
			}

			sendEvent({
				idempotencyKey: createIdempotencyKey(),
				namespace,
				id,
				type: "subscription.stop",
				output: {},
			});
		} else {
			sendEvent({
				idempotencyKey: createIdempotencyKey(),
				namespace,
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

		const portId = nextPortId++;
		const tabId = port.sender?.tab?.id;
		const isContentScriptOrOptions = tabId !== undefined;

		// TODO: uncomment?
		// if (isContentScriptOrOptions) {
		logger.debug("adding port", portId);
		ports.add(port);
		// }

		logger.debug(
			`Port connected ${portId}, tabId: ${tabId}, isContentScriptOrOptions: ${isContentScriptOrOptions}, url: ${port.sender?.url}`,
		);

		port.onDisconnect.addListener(() => {
			// TODO: should not disconnect all subscriptions
			subscriptions.forEach(unsub => unsub());
			ports.delete(port);
		});

		port.onMessage.addListener(message => {
			void onMessage(message, port, port.sender);

			return "ack";
		});
	});

	return { namespace, router };
};
