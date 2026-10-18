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

export const createRouter = (namespace: string) => {
	const werpc = initWERPC();

	return werpc.router({
		ping: werpc.procedure.query(
			({ ctx }) =>
				`pong from ${namespace} (tab: ${ctx.tabId ?? "none"}) (client: ${ctx.clientName})`,
		),
		boom: werpc.procedure.query(() => {
			throw new Error(`boom from ${namespace}`);
		}),
		poll: werpc.procedure.subscription(async function* (opts) {
			for (let i = 0; !opts.signal?.aborted && i < 4; i++) {
				yield `${i} (tab: ${opts.ctx.tabId ?? "none"})`;
				await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
			}
		}),
	});
};

export const createHandler = <TNamespace extends string>(namespace: TNamespace) => {
	return werpcCreateHandler({ namespace, router: createRouter(namespace) });
};

export const pingAll = (namespace: string) => {
	if (namespace === "background") {
		return;
	}

	const container = document.createElement("div");
	container.dataset["testid"] = `panel-${namespace}`;
	container.style.border = "1px solid black";
	container.style.minWidth = "500px";

	const renderStatus = (peer: string, text: string) => {
		const element = document.getElementById(`${namespace}-status-${peer}`);
		if (element) {
			element.textContent = `${peer}: ${text}`;
		}
	};

	const renderPoll = (peer: string, text: string) => {
		const element = document.getElementById(`${namespace}-poll-${peer}`);
		if (element) {
			element.textContent = `${peer}: ${text}`;
		}
	};

	const scopeToTab = namespace.startsWith("content");
	const client = createClient({ clientName: namespace, scopeToTab });

	for (const peer of namespaces) {
		const queryStatus = document.createElement("p");
		queryStatus.id = `${namespace}-status-${peer}`;
		queryStatus.dataset["testid"] = `status-${namespace}-${peer}`;
		queryStatus.textContent = `${peer}: waiting...`;
		container.append(queryStatus);

		const pollStatus = document.createElement("p");
		pollStatus.id = `${namespace}-poll-${peer}`;
		pollStatus.dataset["testid"] = `poll-${namespace}-${peer}`;
		pollStatus.textContent = `${peer}: poll waiting...`;
		container.append(pollStatus);

		client[peer].poll.subscribe(undefined, {
			onData: data => renderPoll(peer, `data ${data}`),
			onError: error => renderPoll(peer, `error ${error.message}`),
			onComplete: () => {
				const element = document.getElementById(`${namespace}-poll-${peer}`);
				if (element && element.textContent && !element.textContent.includes("error")) {
					element.textContent += " (completed)";
				}
			},
		});

		void client[peer].ping
			.query()
			.then(result => renderStatus(peer, result))
			.catch((error: Error) => renderStatus(peer, `error ${error.message}`));
	}

	document.body.append(container);
};
