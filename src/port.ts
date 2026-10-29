import { isBridgeHelloAck, PROTOCOL_VERSION } from "./bridge";
import { WERPC_NAMESPACE } from "./constants";

type OnMessageListener = (message: unknown, sender?: chrome.runtime.MessageSender) => void;

const HELLO_RETRY_MS = 500;

/**
 * Single chrome.runtime.Port connection to the service worker.
 *
 * Chrome may drop port messages dispatched before the receiving side attached
 * its onMessage listener (a real race during service worker cold start), so
 * this port performs a hello/ack handshake: outgoing messages are queued
 * until the service worker acknowledges readiness, and re-queued after every
 * reconnect.
 */
export class WERPCPort {
	private port: chrome.runtime.Port | null = null;
	private closed = false;
	private ready = false;
	private pending: unknown[] = [];
	private listeners = new Set<OnMessageListener>();
	private reconnectedListeners = new Set<() => void>();
	private helloTimer: ReturnType<typeof setTimeout> | undefined;

	public get sender() {
		return this.port?.sender;
	}

	public onMessage = (cb: OnMessageListener) => {
		this.ensure();
		this.listeners.add(cb);
	};

	public onReconnect = (cb: () => void): VoidFunction => {
		this.reconnectedListeners.add(cb);
		return () => {
			this.reconnectedListeners.delete(cb);
		};
	};

	public close = () => {
		try {
			this.port?.disconnect();
		} catch {
			/* empty */
		}

		this.port = null;
		this.closed = true;
		this.ready = false;
		this.pending = [];
		this.listeners.clear();
		this.reconnectedListeners.clear();

		if (this.helloTimer !== undefined) {
			clearTimeout(this.helloTimer);
			this.helloTimer = undefined;
		}
	};

	public postMessage = <T = unknown>(message: T) => {
		if (this.closed) {
			throw new Error("WERPCPort is closed");
		}

		if (!this.ready) {
			this.pending.push(message);
			return;
		}

		try {
			this.ensure().postMessage(message);
		} catch {
			// the underlying port object went stale (e.g. the service worker
			// died between calls): reconnect and re-queue behind the handshake
			this.reconnect();
			this.pending.push(message);
		}
	};

	private ensure = () => {
		if (this.closed) {
			throw new Error("WERPCPort is closed");
		}

		if (this.port) {
			return this.port;
		}

		this.ready = false;
		this.port = chrome.runtime.connect(undefined, { name: WERPC_NAMESPACE });
		this.port.onMessage.addListener(message => {
			if (isBridgeHelloAck(message)) {
				this.flush();
				return;
			}

			this.notify(message, this.port?.sender);
		});
		this.port.onDisconnect.addListener(this.reconnect);
		this.sendHello();

		return this.port;
	};

	private sendHello = () => {
		this.port?.postMessage({ werpc_hello: { v: PROTOCOL_VERSION } });

		if (this.helloTimer !== undefined) {
			clearTimeout(this.helloTimer);
		}

		this.helloTimer = setTimeout(() => {
			if (!this.ready) {
				this.sendHello();
			}
		}, HELLO_RETRY_MS);
	};

	private flush = () => {
		this.ready = true;

		if (this.helloTimer !== undefined) {
			clearTimeout(this.helloTimer);
			this.helloTimer = undefined;
		}

		while (this.pending.length > 0 && this.port) {
			const message = this.pending[0];

			try {
				this.port.postMessage(message);
			} catch {
				// port died mid-flush: reconnect and keep the queue ordered
				this.reconnect();
				return;
			}

			this.pending.shift();
		}
	};

	private reconnect = () => {
		try {
			this.port?.disconnect();
		} catch {
			/* empty */
		}

		this.port = null;

		try {
			this.ensure();
		} catch {
			// extension context invalidated: nothing to reconnect to
			return;
		}

		for (const listener of this.reconnectedListeners) {
			listener();
		}
	};

	private notify = (message: unknown, sender?: chrome.runtime.MessageSender) => {
		this.listeners.forEach(listener => listener(message, sender));
	};
}
