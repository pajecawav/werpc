import { createTRPCClient, TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { BridgeRequest, isBridgeEvent } from "../bridge";
import { detectContext, isBackgroundContext } from "../detect";
import { EventEmitter } from "../events";
import { WERPCPort } from "../port";
import { WERPCNamespaces } from "../types";
import { createWERPCLink, LinkEvents } from "./link";

export type WERPClient = {
	[Namespace in keyof WERPCNamespaces]: TRPCClient<WERPCNamespaces[Namespace]>;
} & {
	/** Close the underlying port; further calls will throw. */
	dispose(): void;
};

export interface CreateClientOptions {
	clientName?: string;
	/**
	 * Explicit tab id for contexts whose port has no sender tab
	 * (side panels, devtools panels, popups). Makes requests participate
	 * in tab-scoped routing: `scopeToTab` filters handlers by this tab,
	 * and `ctx.tabId` on the handler side reports it. Overrides the
	 * devtools inspected-tab auto-detection.
	 */
	tabId?: number;
	scopeToTab?: boolean;
	/**
	 * Deliver every request to all owners of the namespace (matching the
	 * scopeToTab filter) instead of exactly one. Intended for broadcast
	 * scenarios: multiple content scripts or devtools panels serving the
	 * same namespace. Responses merge: the first output (or error) wins
	 * for queries/mutations, subscription streams are concatenated.
	 */
	fanout?: boolean;
	/** Fail queries/mutations after this long (ms). Default 30s, 0 disables. */
	timeoutMs?: number;
}

class ClientManager {
	private clientId = crypto.randomUUID();
	private events = new EventEmitter<LinkEvents>();
	private port = new WERPCPort();
	private clients = new Map<string, TRPCClient<AnyRouter>>();

	public constructor(private options: CreateClientOptions) {
		this.port.onMessage(this.onMessage);
	}

	public getClient<TNamespace extends keyof WERPCNamespaces>(
		namespace: TNamespace,
	): TRPCClient<WERPCNamespaces[TNamespace]> {
		const existingClient = this.clients.get(namespace);
		if (existingClient) {
			return existingClient;
		}

		const link = createWERPCLink({
			clientId: this.clientId,
			clientName: this.options.clientName,
			tabId: this.options.tabId ?? (this.options.scopeToTab ? getDevtoolsTabId() : undefined),
			namespace,
			scopeToTab: this.options.scopeToTab,
			fanout: this.options.fanout,
			events: this.events,
			postRequest: this.postMessage,
			timeoutMs: this.options.timeoutMs ?? 30_000,
			onPortReconnect: this.onPortReconnect,
		});
		const client = createTRPCClient({ links: [link] });
		this.clients.set(namespace, client);

		return client;
	}

	public dispose = () => {
		this.port.close();
	};

	private postMessage = (message: BridgeRequest) => {
		this.port.postMessage(message);
	};

	private onPortReconnect = (cb: () => void): VoidFunction => {
		return this.port.onReconnect(cb);
	};

	private onMessage = (message: unknown) => {
		if (!isBridgeEvent(message)) {
			return;
		}

		const event = message.werpc_event;

		if (event.context.clientId === this.clientId) {
			this.events.emit(`${event.context.namespace}:${event.id}`, event);
		}
	};
}

/** Devtools panels are not tab-scoped by sender, but they inspect a concrete tab. */
const getDevtoolsTabId = (): number | undefined => {
	const devtools = (
		globalThis as { chrome?: { devtools?: { inspectedWindow?: { tabId?: number } } } }
	).chrome?.devtools;

	return typeof devtools?.inspectedWindow?.tabId === "number"
		? devtools.inspectedWindow.tabId
		: undefined;
};

export const createClient = (options: CreateClientOptions = {}): WERPClient => {
	if (isBackgroundContext(detectContext())) {
		throw new Error(
			"Can't use client in a background context (service worker or event page). Use createHandler instead",
		);
	}

	const clientManager = new ClientManager(options);

	return new Proxy<WERPClient>({} as WERPClient, {
		get(_, prop) {
			if (typeof prop !== "string") {
				return undefined;
			}

			if (prop === "dispose") {
				return () => clientManager.dispose();
			}

			return clientManager.getClient(prop as keyof WERPCNamespaces);
		},
	});
};
