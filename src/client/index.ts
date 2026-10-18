import { createTRPCClient, TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import { BridgeRequest, isBridgeEvent } from "../bridge";
import { detectContext } from "../detect";
import { EventEmitter } from "../events";
import { WERPCPort } from "../port";
import { WERPCNamespaces } from "../types";
import { createWERPCLink, LinkEvents } from "./link";

export type WERPClient = {
	[Namespace in keyof WERPCNamespaces]: TRPCClient<WERPCNamespaces[Namespace]>;
};

export interface CreateClientOptions {
	clientName?: string;
	scopeToTab?: boolean;
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
			tabId: this.options.scopeToTab ? getDevtoolsTabId() : undefined,
			namespace,
			scopeToTab: this.options.scopeToTab,
			events: this.events,
			postRequest: this.postMessage,
			timeoutMs: this.options.timeoutMs ?? 30_000,
		});
		const client = createTRPCClient({ links: [link] });
		this.clients.set(namespace, client);

		return client;
	}

	private postMessage = (message: BridgeRequest) => {
		this.port.postMessage(message);
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
	if (detectContext() === "service_worker") {
		throw new Error("Can't use client in background worker context. Use subscriptions instead");
	}

	const clientManager = new ClientManager(options);

	return new Proxy<WERPClient>(
		{},
		{
			get(_, namespace) {
				if (typeof namespace !== "string") {
					throw new Error("Invalid namespace");
				}

				return clientManager.getClient(namespace as keyof WERPCNamespaces);
			},
		},
	);
};
