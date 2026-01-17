import { createClient } from "../../src/client";

export const pingAll = (namespace: string) => {
	const log = (...args: unknown[]) => {
		console.log(`[${namespace}] GOT RESPONSE`, ...args);

		if (typeof document !== "undefined") {
			document.body.innerHTML += `<p>${args.join(" ")}</p>`;
		}
	};

	const client = createClient();

	setTimeout(() => {
		if (namespace !== "background") {
			void client.background.ping.query().then(log);
		}

		if (namespace !== "content") {
			void client.content.ping.query().then(log);
		}

		if (namespace !== "kek") {
			void client.kek.ping.query().then(log);
		}
		// void client.devtools.ping.query().then(log);
		// void client.devtoolsPanel.ping.query().then(log);
		// void client.options.ping.query().then(log);
		// void client.popup.ping.query().then(log);
	}, 100);

	// if (namespace.startsWith("content")) {
	// 	setInterval(() => console.log("aaa"), 1000);
	// }
};
