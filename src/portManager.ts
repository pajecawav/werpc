// import browser from "webextension-polyfill";
// import { WERPC_NAMESPACE } from "./constants";

// type OnPortChangedListener = (
// 	newPort: browser.Runtime.Port,
// 	prevPort: browser.Runtime.Port,
// ) => void;

// // TODO: wrap port and expose methods like onMessage without the need for onPortChanged
// export class PortManager {
// 	private listeners = new Set<OnPortChangedListener>();

// 	// public port = browser.runtime.connect({ name: WERPC_NAMESPACE });

// 	public constructor() {
// 		this.port.onDisconnect.addListener(this.reconnect);
// 	}

// 	public onPortChanged = (cb: OnPortChangedListener) => {
// 		this.listeners.add(cb);
// 	};

// 	private reconnect = () => {
// 		const prevPort = this.port;

// 		try {
// 			this.port.disconnect();
// 		} catch {
// 			/* empty */
// 		}

// 		this.port = browser.runtime.connect();
// 		this.port.onDisconnect.addListener(this.reconnect);
// 		this.listeners.forEach(listener => listener(this.port, prevPort));
// 	};
// }

// export const portManager = new PortManager();
