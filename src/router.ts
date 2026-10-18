import { BridgeErrorOutput, BridgeEventPayload, BridgeRequest } from "./bridge";
import { createIdempotencyKey } from "./idempotency/key";

export interface PortLike {
	postMessage(message: unknown): void;
	sender?: chrome.runtime.MessageSender;
}

/** A handler running in the same context as the router (the service worker). */
export interface RoutingHandler {
	acceptRequest(request: BridgeRequest["werpc_request"], fromPort: PortLike): Promise<void>;
	/** Abort all subscriptions belonging to a client whose port died. */
	dropClient(clientId: string): void;
}

type Owner = { kind: "local"; handler: RoutingHandler } | { kind: "port"; port: PortLike };

interface AnnounceMessage {
	werpc_announce: {
		namespace: string;
	};
}

/**
 * How long an unroutable request waits for a late `announce` before failing.
 * Covers the SW-restart race where a client's request can beat the target
 * handler's re-announce.
 */
const ROUTING_GRACE_MS = 300;

const isAnnounce = (message: unknown): message is AnnounceMessage => {
	if (typeof message !== "object" || message === null || !("werpc_announce" in message)) {
		return false;
	}

	const announce = message.werpc_announce;

	return (
		typeof announce === "object" &&
		announce !== null &&
		typeof (announce as { namespace?: unknown }).namespace === "string"
	);
};

const isEventMessage = (message: unknown): message is { werpc_event: BridgeEventPayload } => {
	return typeof message === "object" && message !== null && "werpc_event" in message;
};

const isRequestMessage = (message: unknown): message is BridgeRequest => {
	return typeof message === "object" && message !== null && "werpc_request" in message;
};

const safePost = (port: PortLike, message: unknown) => {
	try {
		port.postMessage(message);
		return true;
	} catch {
		return false;
	}
};

/**
 * Message router running in the service worker. Shared by all handler
 * instances in the same context. Non-SW handlers announce their namespaces
 * over their port; requests are routed to exactly one owner, events are
 * delivered to the port the requesting client lives on.
 */
class Router {
	private owners = new Map<string, Owner[]>();
	private clientPorts = new Map<string, PortLike>();
	private localHandlers = new Set<RoutingHandler>();

	public registerLocal = (namespace: string, handler: RoutingHandler) => {
		this.addOwner(namespace, { kind: "local", handler });
		this.localHandlers.add(handler);
	};

	public unregisterLocal = (namespace: string, handler: RoutingHandler) => {
		this.removeOwners(namespace, owner => owner.kind === "local" && owner.handler === handler);
		this.localHandlers.delete(handler);
	};

	public registerPortNamespace = (namespace: string, port: PortLike) => {
		this.removeOwners(namespace, owner => owner.kind === "port" && owner.port === port);
		this.addOwner(namespace, { kind: "port", port });
	};

	public forgetPort = (port: PortLike) => {
		const droppedClients = [...this.clientPorts.entries()]
			.filter(([, clientPort]) => clientPort === port)
			.map(([clientId]) => clientId);

		for (const namespace of this.owners.keys()) {
			this.removeOwners(namespace, owner => owner.kind === "port" && owner.port === port);

			if (!this.owners.get(namespace)?.length) {
				this.owners.delete(namespace);
			}
		}

		for (const clientId of droppedClients) {
			this.clientPorts.delete(clientId);

			// abort subscriptions owned by local handlers
			for (const handler of this.localHandlers) {
				handler.dropClient(clientId);
			}

			// tell remote handlers to drop this client's subscriptions too
			for (const owner of this.allPortOwners()) {
				safePost(owner.port, { werpc_drop: { clientId } });
			}
		}
	};

	public handleMessage = (message: unknown, fromPort: PortLike) => {
		if (isAnnounce(message)) {
			this.registerPortNamespace(message.werpc_announce.namespace, fromPort);
			return;
		}

		if (isEventMessage(message)) {
			const clientPort = this.clientPorts.get(message.werpc_event.context.clientId);

			if (clientPort && !safePost(clientPort, message)) {
				this.forgetPort(clientPort);
			}

			return;
		}

		if (isRequestMessage(message)) {
			const request = message.werpc_request;
			this.clientPorts.set(request.context.clientId, fromPort);
			// propagate the resolved tab id so the owning handler sees it in ctx
			request.context.tabId ??= fromPort.sender?.tab?.id;
			this.routeRequest(message, fromPort, 0);
		}
	};

	/** @internal -- test isolation only */
	public reset = () => {
		this.owners.clear();
		this.clientPorts.clear();
	};

	private routeRequest = (message: BridgeRequest, fromPort: PortLike, attempt: number) => {
		const request = message.werpc_request;
		const { namespace, scopeToTab } = request.context;
		const tabId = request.context.tabId ?? fromPort.sender?.tab?.id;
		const owner = this.resolveOwner(namespace, scopeToTab ? tabId : undefined);

		if (!owner) {
			if (attempt === 0) {
				// the target handler may still be re-announcing after a SW restart
				setTimeout(() => this.routeRequest(message, fromPort, 1), ROUTING_GRACE_MS);
				return;
			}

			safePost(fromPort, {
				werpc_event: {
					idempotencyKey: createIdempotencyKey(),
					context: request.context,
					id: request.id,
					type: "error",
					output: {
						message: `Namespace not found: ${namespace}`,
						code: "NOT_FOUND",
						path: request.path,
					} satisfies BridgeErrorOutput,
				},
			});

			return;
		}

		if (owner.kind === "local") {
			void owner.handler.acceptRequest(request, fromPort);
			return;
		}

		if (!safePost(owner.port, message)) {
			this.forgetPort(owner.port);
			safePost(fromPort, {
				werpc_event: {
					idempotencyKey: createIdempotencyKey(),
					context: request.context,
					id: request.id,
					type: "error",
					output: {
						message: `Target context for namespace "${namespace}" disconnected`,
						code: "INTERNAL_SERVER_ERROR",
						path: request.path,
					} satisfies BridgeErrorOutput,
				},
			});
		}
	};

	private resolveOwner = (namespace: string, tabId: number | undefined): Owner | undefined => {
		const owners = this.owners.get(namespace);

		if (!owners || owners.length === 0) {
			return undefined;
		}

		if (tabId !== undefined) {
			const tabMatch = owners.find(
				owner => owner.kind === "port" && owner.port.sender?.tab?.id === tabId,
			);

			if (tabMatch) {
				return tabMatch;
			}
		}

		const first = owners[0];
		return first;
	};

	private addOwner = (namespace: string, owner: Owner) => {
		const owners = this.owners.get(namespace) ?? [];
		owners.push(owner);
		this.owners.set(namespace, owners);
	};

	private allPortOwners = (): { kind: "port"; port: PortLike }[] => {
		const ports = new Map<PortLike, { kind: "port"; port: PortLike }>();

		for (const owners of this.owners.values()) {
			for (const owner of owners) {
				if (owner.kind === "port") {
					ports.set(owner.port, owner);
				}
			}
		}

		return [...ports.values()];
	};

	private removeOwners = (namespace: string, predicate: (owner: Owner) => boolean) => {
		const owners = this.owners.get(namespace);

		if (!owners) {
			return;
		}

		this.owners.set(
			namespace,
			owners.filter(owner => !predicate(owner)),
		);
	};
}

export const router = new Router();
