import { WERPC_NAMESPACE } from "./constants";

type OnMessageListener = (message: unknown, sender?: chrome.runtime.MessageSender) => void;

export class WERPCPort {
	private port: chrome.runtime.Port | null = null;
	private listeners = new Set<OnMessageListener>();

	private constructor() {}

	private static instance: WERPCPort | null = null;

	public static getInstance = () => {
		if (!this.instance) {
			this.instance = new WERPCPort();
		}

		return this.instance;
	};

	public get sender() {
		return this.port?.sender;
	}

	public onMessage = (cb: OnMessageListener) => {
		this.ensure();
		this.listeners.add(cb);
	};

	public postMessage = <T = unknown>(message: T) => {
		const port = this.ensure();
		port.postMessage(message);
	};

	private ensure = () => {
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
		this.ensure();
	};

	private notify = (message: unknown, sender?: chrome.runtime.MessageSender) => {
		this.listeners.forEach(listener => listener(message, sender));
	};
}
