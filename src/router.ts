import {
	BridgeErrorOutput,
	BridgeRequest,
	isBridgeAnnounce,
	isBridgeEvent,
	isBridgeHello,
	isBridgeRequest,
	PROTOCOL_VERSION,
} from "./bridge";

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

type Owner =
	| { kind: "local"; handler: RoutingHandler }
	| { kind: "port"; port: PortLike; tabId: number | undefined };

/**
 * How long an unroutable request waits for a late `announce` before failing.
 * Covers the SW-restart race where a client's request can beat the target
 * handler's re-announce.
 */
const ROUTING_GRACE_MS = 300;

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

	public registerPortNamespace = (
		namespace: string,
		port: PortLike,
		tabId: number | undefined,
	) => {
		this.removeOwners(namespace, owner => owner.kind === "port" && owner.port === port);
		this.addOwner(namespace, { kind: "port", port, tabId });
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
				safePost(owner.port, { werpc_drop: { v: PROTOCOL_VERSION, clientId } });
			}
		}
	};

	public handleMessage = (message: unknown, fromPort: PortLike) => {
		if (isBridgeHello(message)) {
			// port handshake: the sender queues its messages until this ack,
			// so nothing is lost while listeners are still being attached
			safePost(fromPort, { werpc_hello_ack: { v: PROTOCOL_VERSION } });
			return;
		}

		if (isBridgeAnnounce(message)) {
			this.registerPortNamespace(
				message.werpc_announce.namespace,
				fromPort,
				message.werpc_announce.tabId,
			);
			return;
		}

		if (isBridgeEvent(message)) {
			const clientPort = this.clientPorts.get(message.werpc_event.context.clientId);

			if (clientPort && !safePost(clientPort, message)) {
				this.forgetPort(clientPort);
			}

			return;
		}

		if (isBridgeRequest(message)) {
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
		const { namespace, scopeToTab, fanout } = request.context;
		const tabId = request.context.tabId ?? fromPort.sender?.tab?.id;
		const owners = this.resolveOwners(namespace, scopeToTab ? tabId : undefined);

		if (owners.length === 0) {
			if (attempt === 0) {
				// the target handler may still be re-announcing after a SW restart
				setTimeout(() => this.routeRequest(message, fromPort, 1), ROUTING_GRACE_MS);
				return;
			}

			safePost(fromPort, {
				werpc_event: {
					v: PROTOCOL_VERSION,
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

		// fan-out requests (and subscription stops, which must reach every
		// owner that may hold a subscription) go to all matching owners;
		// everything else goes to exactly one for exactly-once semantics
		const targets = fanout || request.type === "subscription.stop" ? owners : [owners[0]!];

		let delivered = 0;

		for (const owner of targets) {
			if (owner.kind === "local") {
				void owner.handler.acceptRequest(request, fromPort);
				delivered++;
				continue;
			}

			if (safePost(owner.port, message)) {
				delivered++;
				continue;
			}

			this.forgetPort(owner.port);
		}

		if (delivered === 0) {
			safePost(fromPort, {
				werpc_event: {
					v: PROTOCOL_VERSION,
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

	private resolveOwners = (namespace: string, tabId: number | undefined): Owner[] => {
		const owners = this.owners.get(namespace);

		if (!owners || owners.length === 0) {
			return [];
		}

		if (tabId !== undefined) {
			const tabMatches = owners.filter(
				owner =>
					owner.kind === "port" && (owner.tabId ?? owner.port.sender?.tab?.id) === tabId,
			);

			if (tabMatches.length > 0) {
				return tabMatches;
			}
		}

		return owners;
	};

	private addOwner = (namespace: string, owner: Owner) => {
		const owners = this.owners.get(namespace) ?? [];
		owners.push(owner);
		this.owners.set(namespace, owners);
	};

	private allPortOwners = (): { kind: "port"; port: PortLike; tabId: number | undefined }[] => {
		const ports = new Map<
			PortLike,
			{ kind: "port"; port: PortLike; tabId: number | undefined }
		>();

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
