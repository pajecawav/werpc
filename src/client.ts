import { createTRPCClient, TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import * as v from "valibot";
import { bridgeEventSchema, BridgeRequest } from "./bridge";
import { detectContext } from "./detect";
import { createWERPCLink, WERPCLink } from "./link";
import { WERPCPort } from "./port";
import { WERPCNamespaces } from "./types";
import { createIdempotencyKey } from "./idempotency/key";

export type WERPClient = {
	[Namespace in keyof WERPCNamespaces]: TRPCClient<WERPCNamespaces[Namespace]>;
};

interface NamespacedWERPCClient {
	client: TRPCClient<AnyRouter>;
	link: WERPCLink;
}

// TODO: define as a class, export an instance
export const createClient = (): WERPClient => {
	if (detectContext() === "service_worker") {
		throw new Error("Can't use client in background worker context. Use subscriptions instead");
	}

	const clientId = createIdempotencyKey();
	const listeners = new Map<string, (result: unknown) => void>();

	const onMessage = (message: unknown) => {
		const r = v.safeParse(bridgeEventSchema, message);

		if (!r.success) {
			return;
		}

		const {
			// TODO: handle idempotency?
			// idempotencyKey,
			clientId: eventClientId,
			id,
			namespace,
			type,
			output,
		} = r.output.werpc_event;

		if (eventClientId !== clientId) {
			return;
		}

		const namespacedKey = `${namespace}:${id}`;

		if (type === "subscription.stop") {
			listeners.delete(namespacedKey);
		} else if (type === "subscription.output") {
			const cb = listeners.get(namespacedKey);
			cb?.(output);
		} else {
			const cb = listeners.get(namespacedKey);
			listeners.delete(namespacedKey);
			cb?.(output);
		}
	};

	const port = WERPCPort.getInstance();
	port.onMessage(onMessage);

	const postMessage = (message: BridgeRequest) => {
		port.postMessage(message);
	};

	const clients = new Map<string, NamespacedWERPCClient>();

	return new Proxy({} as WERPClient, {
		get(_, namespace) {
			if (typeof namespace !== "string") {
				throw new Error("Invalid namespace");
			}

			const existingClient = clients.get(namespace);
			if (existingClient) {
				return existingClient.client;
			}

			const link = createWERPCLink({ clientId, namespace, listeners, postMessage });
			const client = createTRPCClient({ links: [link] });

			clients.set(namespace, { client, link });

			return client;
		},
	});
};
