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
	scopeToTab?: boolean;
}

// TODO: define as a class, export an instance
export const createClient = ({ scopeToTab }: CreateClientOptions = {}): WERPClient => {
	if (detectContext() === "service_worker") {
		throw new Error("Can't use client in background worker context. Use subscriptions instead");
	}

	const clientId = createIdempotencyKey();
	const events = new EventEmitter<LinkEvents>();
	const idempotencyManager = new IdempotencyManager();

	const onMessage = (message: unknown) => {
		const r = v.safeParse(bridgeEventSchema, message);

		if (!r.success) {
			return;
		}

		const event = r.output.werpc_event;

		if (
			event.context.clientId === clientId &&
			!idempotencyManager.isDuplicate(event.idempotencyKey)
		) {
			events.emit(`${event.context.namespace}:${event.id}`, event);
		}
	};

	const port = WERPCPort.getInstance();
	port.onMessage(onMessage);

	const postMessage = (message: BridgeRequest) => {
		port.postMessage(message);
	};

	const clients = new Map<string, TRPCClient<AnyRouter>>();

	return new Proxy({} as WERPClient, {
		get(_, namespace) {
			if (typeof namespace !== "string") {
				throw new Error("Invalid namespace");
			}

			const existingClient = clients.get(namespace);
			if (existingClient) {
				return existingClient;
			}

			const link = createWERPCLink({
				clientId,
				namespace,
				events,
				postRequest: postMessage,
				scopeToTab,
			});
			const client = createTRPCClient({ links: [link] });

			clients.set(namespace, client);

			return client;
		},
	});
};
