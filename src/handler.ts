import { AnyProcedure, AnyRouter } from "@trpc/server";
import { isObservable, observableToAsyncIterable } from "@trpc/server/observable";
import { isAsyncIterable } from "@trpc/server/unstable-core-do-not-import";
import * as v from "valibot";
import browser from "webextension-polyfill";
import { BridgeEvent, BridgeEventPayload, BridgeRequest, bridgeRequestSchema } from "./bridge";
import { IDEMPOTENCY_KEY_TTL_MS, WERPC_NAMESPACE } from "./constants";
import { WERPCContext } from "./context";
import { createLogger } from "./logger";
import { createIdempotencyKey } from "./key";

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

	const ports = new Set<browser.Runtime.Port>();

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

		const sendEvent = (payload: BridgeEventPayload) => {
			logger.debug("sending event", payload);
			const event: BridgeEvent = { werpc: payload };
			port.postMessage(event);
		};

		// TODO: keys should include namespace and probably port id???
		const subscriptions = new Map<number, VoidFunction>();
		const seenIdempotencyKeys = new Set<string>();

		port.onDisconnect.addListener(() => {
			logger.debug(`Port disconnected ${portId}`);
			subscriptions.forEach(unsub => unsub());
			ports.delete(port);
		});

		/*
		 * Broadcast message to connected ports
		 */
		const broadcast = (request: BridgeRequest) => {
			logger.debug("broadcasting", request);
			for (const p of ports) {
				logger.debug("broadcasting to", p);
				// TODO: resend to options?
				// if (
				// 	p !== port
				// 	// && p.sender?.tab?.id === tabId
				// 	// && p.sender?.url?.startsWith("chrome-extension://")
				// ) {
				void p.postMessage(request);
				// }
			}
		};

		const onMessage = async (message: unknown) => {
			const r = v.safeParse(bridgeRequestSchema, message);

			if (!r.success) {
				return;
			}

			const { idempotencyKey, namespace: _namespace, id, path, type, input } = r.output.werpc;

			if (seenIdempotencyKeys.has(idempotencyKey)) {
				return;
			}
			seenIdempotencyKeys.add(idempotencyKey);
			setTimeout(() => seenIdempotencyKeys.delete(idempotencyKey), IDEMPOTENCY_KEY_TTL_MS);

			logger.debug("received message:", r.output.werpc);
			if (_namespace !== namespace) {
				// TODO: revert?
				// if (isContentScriptOrOptions) {
				broadcast(r.output);
				// }

				return;
			}

			logger.debug(`Got message from ${portId}:`, r.output.werpc);

			if (type === "subscription.stop") {
				subscriptions.get(id)?.();
				subscriptions.delete(id);
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
				if (subscriptions.has(id)) {
					throw new Error(`Duplicate subscription with id ${id}`);
				}

				if (!isAsyncIterable(output) && !isObservable(output)) {
					throw new Error(
						`Expected an observable or async iterable, got ${typeof output}`,
					);
				}

				const iterable = isObservable(output)
					? observableToAsyncIterable(output, ac.signal)
					: output;

				subscriptions.set(id, () => ac.abort());

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

		port.onMessage.addListener(message => {
			void onMessage(message);

			return "ack";
		});
	});

	return { namespace, router };
};
