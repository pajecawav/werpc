/**
 * Fake chrome.runtime hub emulating MV3 port semantics:
 * - `connect()` from a context fans `onConnect` out to every other non-content
 *   context (content scripts never receive onConnect, like in Chrome).
 * - postMessage on the connector's port fans out to all listener ports.
 * - postMessage on a listener port delivers only back to the connector.
 * - FIFO delivery per port via microtasks (like Chrome).
 * - A port can be killed silently (postMessage throws, no onDisconnect) to
 *   simulate the missed-disconnect race.
 */

export type ContextKind = "sw" | "page" | "content";

export interface FakeSender {
	tab?: { id: number };
}

export interface LogEntry {
	from: string;
	to: string;
	type: string;
	ns?: string;
	path?: string;
	id?: number;
}

type MessageListener = (message: unknown, port: FakePort) => void;

export interface FakePort {
	name: string;
	sender: chrome.runtime.MessageSender | undefined;
	postMessage(message: unknown): void;
	onMessage: { addListener(cb: MessageListener): void };
	onDisconnect: { addListener(cb: (port: FakePort) => void): void };
	disconnect(): void;
	_listeners: Set<MessageListener>;
	_disconnectListeners: Set<(port: FakePort) => void>;
}

interface Connection {
	id: number;
	connectorCtxId: string;
	listenerPorts: Map<string, FakePort>;
	connectorPort: FakePort;
	dead: boolean;
}

interface FakeContext {
	kind: ContextKind;
	sender: FakeSender | undefined;
	onConnectListeners: Set<(port: FakePort) => void>;
}

interface Envelope {
	werpc_request?: { type?: string; path?: string; id?: number; context?: { namespace?: string } };
	werpc_event?: { type?: string; id?: number; context?: { namespace?: string } };
}

export class FakeExtension {
	public log: LogEntry[] = [];
	public delayMs = 0;

	private contexts = new Map<string, FakeContext>();
	private connections: Connection[] = [];

	public context(id: string, kind: ContextKind, sender?: FakeSender) {
		this.contexts.set(id, { kind, sender, onConnectListeners: new Set() });
		return id;
	}

	public makeChrome = (ctxId: string): typeof chrome => {
		const chromeApi = {
			runtime: {
				connect: (_extensionId: string | undefined, info: { name?: string }): FakePort =>
					this.connectAs(ctxId, info),
				onConnect: {
					addListener: (cb: (port: FakePort) => void) => {
						const ctx = this.contexts.get(ctxId);
						if (!ctx) {
							throw new Error(`Unknown context ${ctxId}`);
						}
						ctx.onConnectListeners.add(cb);
					},
				},
				getPlatformInfo: () => Promise.resolve({ os: "cros" }),
			},
		};

		return chromeApi as unknown as typeof chrome;
	};

	private connectAs = (ctxId: string, info: { name?: string }): FakePort => {
		const ctx = this.contexts.get(ctxId);
		if (!ctx) {
			throw new Error(`Unknown context ${ctxId}`);
		}

		const conn: Connection = {
			id: this.connections.length,
			connectorCtxId: ctxId,
			listenerPorts: new Map(),
			connectorPort: undefined as unknown as FakePort,
			dead: false,
		};
		conn.connectorPort = this.makePort(conn, ctxId, info.name ?? "", ctx.sender);
		this.connections.push(conn);

		for (const [otherId, otherCtx] of this.contexts) {
			if (otherId === ctxId || otherCtx.kind === "content") {
				continue;
			}

			for (const listener of otherCtx.onConnectListeners) {
				const lport = this.makePort(conn, otherId, info.name ?? "", ctx.sender);
				conn.listenerPorts.set(otherId, lport);
				queueMicrotask(() => listener(lport));
			}
		}

		return conn.connectorPort;
	};

	private makePort = (
		conn: Connection,
		ownerCtxId: string,
		name: string,
		sender: FakeSender | undefined,
	): FakePort => {
		const port: FakePort = {
			name,
			sender: sender as chrome.runtime.MessageSender,
			_listeners: new Set(),
			_disconnectListeners: new Set(),
			postMessage: (message: unknown) => {
				this.deliver(conn, ownerCtxId, message);
			},
			onMessage: {
				addListener(cb: MessageListener) {
					port._listeners.add(cb);
				},
			},
			onDisconnect: {
				addListener(cb: (port: FakePort) => void) {
					port._disconnectListeners.add(cb);
				},
			},
			disconnect: () => {
				this.disconnectConn(conn);
			},
		};
		return port;
	};

	private deliver = (conn: Connection, fromCtxId: string, message: unknown) => {
		const fanout = fromCtxId === conn.connectorCtxId;
		const envelope = message as Envelope | undefined;
		this.log.push({
			from: fromCtxId,
			to: fanout ? "all" : conn.connectorCtxId,
			type: envelope?.werpc_request?.type ?? envelope?.werpc_event?.type ?? "other",
			ns:
				envelope?.werpc_request?.context?.namespace ??
				envelope?.werpc_event?.context?.namespace,
			path: envelope?.werpc_request?.path,
			id: envelope?.werpc_request?.id ?? envelope?.werpc_event?.id,
		});

		if (conn.dead) {
			throw new Error("Attempting to use a disconnected port object");
		}

		const fire = () => {
			const ports = fanout ? [...conn.listenerPorts.values()] : [conn.connectorPort];
			for (const p of ports) {
				for (const cb of p._listeners) {
					queueMicrotask(() => cb(message, p));
				}
			}
		};

		if (this.delayMs > 0) {
			setTimeout(fire, this.delayMs);
		} else {
			queueMicrotask(fire);
		}
	};

	private disconnectConn = (conn: Connection) => {
		conn.dead = true;
		for (const p of [conn.connectorPort, ...conn.listenerPorts.values()]) {
			for (const cb of p._disconnectListeners) {
				queueMicrotask(() => cb(p));
			}
		}
	};

	/** Simulate a port that died without onDisconnect reaching the SW. */
	public killSilently = (ctxId: string) => {
		const conn = this.connections.find(c => c.connectorCtxId === ctxId);
		if (!conn) {
			throw new Error(`No connection from ${ctxId}`);
		}
		conn.dead = true;
	};

	/** Messages routed through the hub (lower bound of real traffic). */
	public get messageCount() {
		return this.log.length;
	}
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const withTimeout = async <T>(p: Promise<T>, ms: number, label = "promise"): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			p,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`TIMEOUT(${label}, ${ms}ms)`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};
