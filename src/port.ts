import { WERPC_NAMESPACE } from "./constants";

type OnMessageListener = (message: unknown, sender?: chrome.runtime.MessageSender) => void;

export class WERPCPort {
	private port: chrome.runtime.Port | null = null;
	private closed = false;
	private listeners = new Set<OnMessageListener>();
	private reconnectedListeners = new Set<() => void>();

	public get sender() {
		return this.port?.sender;
	}

	public onMessage = (cb: OnMessageListener) => {
		this.ensure();
		this.listeners.add(cb);
	};

	public onReconnect = (cb: () => void) => {
		this.reconnectedListeners.add(cb);
	};

	public close = () => {
		try {
			this.port?.disconnect();
		} catch {
			/* empty */
		}

		this.port = null;
		this.closed = true;
		this.listeners.clear();
		this.reconnectedListeners.clear();
	};

	public postMessage = <T = unknown>(message: T) => {
		try {
			this.ensure().postMessage(message);
		} catch {
			// the underlying port object went stale (e.g. the service worker
			// died between calls): reconnect once and retry
			this.reconnect();
			this.ensure().postMessage(message);
		}
	};

	private ensure = () => {
		if (this.closed) {
			throw new Error("WERPCPort is closed");
		}

		if (this.port) {
			return this.port;
		}

		this.port = chrome.runtime.connect(undefined, { name: WERPC_NAMESPACE });
		this.port.onMessage.addListener((message, port) => this.notify(message, port.sender));
		this.port.onDisconnect.addListener(this.reconnect);

		return this.port;
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
