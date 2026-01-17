import { createClient } from "werpc";

export const pingAll = (namespace: string) => {
	const log = (...args: unknown[]) => {
		console.log(`[${namespace}] GOT RESPONSE`, ...args);

		if (typeof document !== "undefined") {
			document.body.innerHTML += `<p>${args.join(" ")}</p>`;
		}
	};

	const client = createClient();

	void client.background.ping.query().then(log);
	void client.content.ping.query().then(log);
	void client.content2.ping.query().then(log);
	void client.devtools.ping.query().then(log);
	void client.devtoolsPanel.ping.query().then(log);
	void client.options.ping.query().then(log);
	void client.popup.ping.query().then(log);
};
