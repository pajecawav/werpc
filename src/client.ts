import { createTRPCClient, TRPCClient } from "@trpc/client";
import { AnyRouter } from "@trpc/server";
import * as v from "valibot";
import browser from "webextension-polyfill";
import { bridgeEventSchema, BridgeRequest } from "./bridge";
import { WERPC_NAMESPACE } from "./constants";
import { detectContext } from "./detect";
import { createWERPCLink, WERPCLink } from "./link";
import { WERPCNamespaces } from "./types";

export type WERPClient = {
	[Namespace in keyof WERPCNamespaces]: TRPCClient<WERPCNamespaces[Namespace]>;
};

interface NamespacedWERPCClient {
	client: TRPCClient<AnyRouter>;
	link: WERPCLink;
}

export const createClient = (): WERPClient => {
	if (detectContext() === "service_worker") {
		throw new Error("Can't use client in background worker context. Use subscriptions instead");
	}

	const listeners = new Map<string, (result: unknown) => void>();

	const createPort = () => {
		const port = browser.runtime.connect({ name: WERPC_NAMESPACE });

		// logger.warn("Connected to port", port.name);

		port.onMessage.addListener(message => {
			const r = v.safeParse(bridgeEventSchema, message);

			if (!r.success) {
				return;
			}

			const {
				// TODO: handle idempotency?
				// idempotencyKey,
				id,
				namespace,
				type,
				output,
			} = r.output.werpc;

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
		});

		port.onDisconnect.addListener(() => {
			// logger.warn("Disconnected from port", port.name);
			reconnect();
		});

		return port;
	};

	let port = createPort();

	const reconnect = () => {
		try {
			port.disconnect();
		} catch {
			/* empty */
		}

		port = createPort();
		// updatePort(port);

		// logger.log("Reconnected to port", port.name);
	};

	// const updatePort = (port: browser.Runtime.Port) => {
	// 	for (const client of clients.values()) {
	// 		client.link.updatePort(port);
	// 	}
	// };

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

			const link = createWERPCLink({ namespace, listeners, postMessage });
			const client = createTRPCClient({ links: [link] });

			clients.set(namespace, { client, link });

			return client;
		},
	});
};
