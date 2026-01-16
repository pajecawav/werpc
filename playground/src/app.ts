// import browser from "webextension-polyfill";
// import { createLogger } from "./logger";
// import { detectContext } from "../../src/detect";

// export const initDebugApp = (name: string) => {
// 	const logger = createLogger(name);

// 	// initHandler({ namespace: name, router });

// 	logger.log("init");

// 	const onMessage = (message: unknown, sender: browser.Runtime.MessageSender) => {
// 		logger.log("received message:", message, sender.frameId, sender.tab?.id);
// 	};

// 	browser.runtime.onMessage.addListener((message, sender) => {
// 		// logger.log("received message:", message, sender.frameId, sender.tab?.id);
// 		onMessage(message, sender);

// 		return "ack";
// 	});

// 	void browser.runtime.sendMessage(`from ${name}`);

// 	// if (name !== "background") {
// 	if (detectContext() !== "service_worker") {
// 		const port = browser.runtime.connect({ name: "werpc" });
// 		void port.postMessage(`fromo ${name} port`);

// 		port.onMessage.addListener((message, sender) => {
// 			onMessage(message, sender);

// 			return "ack";
// 		});

// 		logger.log("init done");
// 	}

// 	return "ack";
// };
