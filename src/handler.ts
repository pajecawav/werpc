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
}

export class WERPCHandler<TNamespace extends string, TRouter extends AnyRouter> {
	private ports = new Set<PortLike>();
	private idempotencyManager = new IdempotencyManager();
	private subscriptions = new Map<string, VoidFunction>();

	public constructor(private readonly options: CreateHandlerOptions<TNamespace, TRouter>) {
		if (detectContext() !== "service_worker") {
			const werpcPort = WERPCPort.getInstance();
			this.ports.add(werpcPort);

			werpcPort.onMessage((message, sender) => {
				void this.onMessage(message, sender);

				return "ack";
			});
		}

		browser.runtime.onConnect.addListener(this.addPort);
	}

	/*
	 * Broadcast message to connected ports
	 */
	private broadcast = (request: BridgeRequest | BridgeEvent, targetTabId: number | undefined) => {
		// if (detectContext() === "service_worker") {
		for (const port of this.ports) {
			const noTargetTab = targetTabId === undefined;
			const portTabId = port.sender?.tab?.id;
			const isTargetTab = portTabId === targetTabId;

			if (noTargetTab || !portTabId || isTargetTab) {
				port.postMessage(request);
			}
		}
		// } else {
		// 	WERPCPort.getInstance().postMessage(request);
		// }
	};

	// TODO: force-disconnect ports for keep-alive
	// https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension
	// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port#lifecycle
	// or https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle#idle-shutdown (use chrome.runtime.getPlatformInfo every <30 seconds?)
	private addPort = (port: browser.Runtime.Port) => {
		if (port.name !== WERPC_NAMESPACE) {
			return;
		}

		this.ports.add(port);

		const intervalId = setInterval(() => {
			void browser.runtime.getPlatformInfo();
		}, 20_000);

		port.onDisconnect.addListener(() => {
			// TODO: this leaks subscriptions, probably need to implement keep-alive for subscriptions?
			this.ports.delete(port);
			clearInterval(intervalId);
		});

		port.onMessage.addListener(message => {
			void this.onMessage(message, port.sender);

			return "ack";
		});
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
		const handler = path
			.split(".")
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
			.reduce((c, segment) => c[segment], caller as any) as AnyProcedure;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return
		return await handler(input as any);
	};

	private onMessage = async (
		message: unknown,
		sender: browser.Runtime.MessageSender | undefined,
	) => {
		const ev = v.safeParse(bridgeEventSchema, message);
		if (ev.success) {
			if (!this.idempotencyManager.isDuplicate(ev.output.werpc_event.idempotencyKey)) {
				ev.output.werpc_event.context.tabId ??= sender?.tab?.id;
				this.broadcast(
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

		const { idempotencyKey, context, id, path, type, input } = req.output.werpc_request;

		if (this.idempotencyManager.isDuplicate(idempotencyKey)) {
			return;
		}

		const { clientId, clientName, namespace: requestNamespace, scopeToTab } = context;
		const tabId = context.tabId ?? sender?.tab?.id;
		const targetTabId = scopeToTab ? tabId : undefined;

		if (requestNamespace !== this.options.namespace) {
			req.output.werpc_request.context.tabId = tabId;
			this.broadcast(req.output, targetTabId);

			return;
		}

		const sendEvent = (payload: BridgeEventPayload) => {
			this.broadcast({ werpc_event: payload }, targetTabId);
		};

		const requestId = `${clientId}:${requestNamespace}:${id}`;

		if (type === "subscription.stop") {
			this.subscriptions.get(requestId)?.();
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
			if (this.subscriptions.has(requestId)) {
				throw new Error(`Duplicate subscription with id ${requestId}`);
			}

			if (!isAsyncIterable(output) && !isObservable(output)) {
				throw new Error(`Expected an observable or async iterable, got ${typeof output}`);
			}

			const iterable = isObservable(output)
				? observableToAsyncIterable(output, ac.signal)
				: output;

			this.subscriptions.set(requestId, () => ac.abort());

			const context: BridgeContext = {
				clientId,
				clientName,
				namespace: this.options.namespace,
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
}

export const createHandler = <TNamespace extends string, TRouter extends AnyRouter>({
	namespace: handlerNamespace,
	router,
}: CreateHandlerOptions<TNamespace, TRouter>): WERPCHandler<TNamespace, TRouter> => {
	return new WERPCHandler({ namespace: handlerNamespace, router });
};
