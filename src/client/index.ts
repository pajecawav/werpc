import { createTRPCClient, TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import * as v from "valibot";
import { bridgeEventSchema, BridgeRequest } from "../bridge";
import { detectContext } from "../detect";
import { EventEmitter } from "../events";
import { createIdempotencyKey } from "../idempotency/key";
import { IdempotencyManager } from "../idempotency/manager";
import { WERPCPort } from "../port";
import { WERPCNamespaces } from "../types";
import { createWERPCLink, LinkEvents } from "./link";

export type WERPClient = {
	[Namespace in keyof WERPCNamespaces]: TRPCClient<WERPCNamespaces[Namespace]>;
};

export interface CreateClientOptions {
	clientName?: string;
	scopeToTab?: boolean;
}

class ClientManager {
	private clientId = createIdempotencyKey();
	private events = new EventEmitter<LinkEvents>();
	private idempotencyManager = new IdempotencyManager();
	private port = WERPCPort.getInstance();
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
			namespace,
			scopeToTab: this.options.scopeToTab,
			events: this.events,
			postRequest: this.postMessage,
		});
		const client = createTRPCClient({ links: [link] });
		this.clients.set(namespace, client);

		return client;
	}

	private postMessage = (message: BridgeRequest) => {
		this.port.postMessage(message);
	};

	private onMessage = (message: unknown) => {
		const r = v.safeParse(bridgeEventSchema, message);

		if (!r.success) {
			return;
		}

		const event = r.output.werpc_event;

		if (
			event.context.clientId === this.clientId &&
			!this.idempotencyManager.isDuplicate(event.idempotencyKey)
		) {
			this.events.emit(`${event.context.namespace}:${event.id}`, event);
		}
	};
}

export const createClient = (options: CreateClientOptions = {}): WERPClient => {
	if (detectContext() === "service_worker") {
		throw new Error("Can't use client in background worker context. Use subscriptions instead");
	}

	const clientManager = new ClientManager(options);

	return new Proxy({} as WERPClient, {
		get(_, namespace) {
			if (typeof namespace !== "string") {
				throw new Error("Invalid namespace");
			}

			return clientManager.getClient(namespace as keyof WERPCNamespaces);
		},
	});
};
