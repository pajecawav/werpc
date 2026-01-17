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
import { createWERPCLink, LinkEvents, WERPCLink } from "./link";

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
	const events = new EventEmitter<LinkEvents>();

	const idempotencyManager = new IdempotencyManager();

	const onMessage = (message: unknown) => {
		const r = v.safeParse(bridgeEventSchema, message);

		if (!r.success) {
			return;
		}

		const {
			idempotencyKey,
			clientId: eventClientId,
			id,
			namespace,
			type,
			output,
		} = r.output.werpc_event;

		if (eventClientId !== clientId || idempotencyManager.isDuplicate(idempotencyKey)) {
			return;
		}

		const namespacedKey = `${namespace}:${id}` as const;

		switch (type) {
			case "subscription.ack":
				events.emit(`${namespacedKey}:sub_ack`);
				break;
			case "subscription.stop":
				// TODO: this is probably incorrect because link should notify observer when subscription is stopped
				// need to figure out a proper way to handle client/server stopping subscription
				events.offAll(`${namespacedKey}:event`);
				break;
			case "subscription.output":
				events.emit(`${namespacedKey}:event`, output);
				break;
			case "output":
				events.emit(`${namespacedKey}:event`, output);
				// events.offAll(`${namespacedKey}:event`);
				break;
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

			const link = createWERPCLink({ clientId, namespace, events, postMessage });
			const client = createTRPCClient({ links: [link] });

			clients.set(namespace, { client, link });

			return client;
		},
	});
};
