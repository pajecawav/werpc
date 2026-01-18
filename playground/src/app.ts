import { createClient, initWERPC, createHandler as werpcCreateHandler } from "werpc";

const namespaces = [
	"background",
	"content",
	"content2",
	"devtools",
	"devtoolsPanel",
	"offscreen",
	"options",
	"popup",
] as const;

export const pingAll = (namespace: string) => {
	if (namespace !== "background") {
		const container = document.createElement("div");
		container.style.border = "1px solid black";
		container.style.minWidth = "500px";

		const log = (...args: unknown[]) => {
			if (typeof document !== "undefined") {
				container.innerHTML += `<p>${args.join(" ")}</p>`;
			}
		};

		const scopeToTab = namespace.startsWith("content");
		const client = createClient({ clientName: namespace, scopeToTab });

		for (const peer of namespaces) {
			if (typeof document !== "undefined") {
				const element = document.createElement("p");
				element.textContent = `${peer}: waiting...`;
				element.id = `${namespace}-status-${peer}`;
				container.append(element);
				client[peer].poll.subscribe(undefined, {
					onData: data => {
						const element = document.getElementById(`${namespace}-status-${peer}`);
						if (element) {
							element.textContent = `${peer}: ${data}`;
						}
					},
					onComplete: () => {
						const element = document.getElementById(`${namespace}-status-${peer}`);
						if (element) {
							element.textContent += " (completed)";
						}
					},
				});
			}

			void client[peer].ping.query().then(log);
		}

		document.body.append(container);
	}
};

export const createHandler = <TNamespace extends string>(namespace: TNamespace) => {
	const werpc = initWERPC();

	return werpcCreateHandler({
		namespace,
		router: werpc.router({
			ping: werpc.procedure.query(
				({ ctx }) =>
					`pong from ${namespace} (tab: ${ctx.tabId}) (client: ${ctx.clientName})`,
			),
			poll: werpc.procedure.subscription(async function* (opts) {
				for (let i = 0; !opts.signal?.aborted && i < 4; i++) {
					yield `${i} ${Math.random().toFixed(3)} (tab: ${opts.ctx.tabId}) (client: ${opts.ctx.clientName})`;
					await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
				}
			}),
		}),
		debug: true,
	});
};
