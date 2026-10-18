export const PROTOCOL_VERSION = 1;

export interface BridgeContext {
	clientId: string;
	clientName: string | undefined;
	namespace: string;
	tabId: number | undefined;
	scopeToTab: boolean | undefined;
}

export type BridgeRequestType = "query" | "mutation" | "subscription.start" | "subscription.stop";

export interface BridgeRequestPayload<Input = unknown> {
	v: number;
	context: BridgeContext;
	id: number;
	path: string;
	type: BridgeRequestType;
	input: Input;
}

export interface BridgeRequest<Input = unknown> {
	werpc_request: BridgeRequestPayload<Input>;
}

export type BridgeErrorOutput = {
	message: string;
	code: string;
	path: string;
};

export type BridgeEventType =
	| "output"
	| "error"
	| "subscription.ack"
	| "subscription.output"
	| "subscription.stop";

export interface BridgeEventPayload<Output = unknown> {
	v: number;
	context: BridgeContext;
	id: number;
	type: BridgeEventType;
	output: Output;
}

export interface BridgeEvent<Output = unknown> {
	werpc_event: BridgeEventPayload<Output>;
}

export interface BridgeAnnounce {
	werpc_announce: {
		v: number;
		namespace: string;
	};
}

export interface BridgeDrop {
	werpc_drop: {
		v: number;
		clientId: string;
	};
}

const REQUEST_TYPES: readonly string[] = [
	"query",
	"mutation",
	"subscription.start",
	"subscription.stop",
];
const EVENT_TYPES: readonly string[] = [
	"output",
	"error",
	"subscription.ack",
	"subscription.output",
	"subscription.stop",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isBridgeContext = (value: unknown): value is BridgeContext => {
	if (!isRecord(value)) {
		return false;
	}

	const clientName = value["clientName"];
	const tabId = value["tabId"];
	const scopeToTab = value["scopeToTab"];

	return (
		typeof value["clientId"] === "string" &&
		(clientName === undefined || typeof clientName === "string") &&
		typeof value["namespace"] === "string" &&
		(tabId === undefined || typeof tabId === "number") &&
		(scopeToTab === undefined || typeof scopeToTab === "boolean")
	);
};

const hasVersion = (value: unknown): boolean => isRecord(value) && value["v"] === PROTOCOL_VERSION;

export const isBridgeRequest = (message: unknown): message is BridgeRequest => {
	if (!isRecord(message) || !isRecord(message["werpc_request"])) {
		return false;
	}

	const request = message["werpc_request"] as Record<string, unknown>;

	return (
		hasVersion(request) &&
		isBridgeContext(request["context"]) &&
		typeof request["id"] === "number" &&
		typeof request["path"] === "string" &&
		typeof request["type"] === "string" &&
		REQUEST_TYPES.includes(request["type"])
	);
};

export const isBridgeEvent = (message: unknown): message is BridgeEvent => {
	if (!isRecord(message) || !isRecord(message["werpc_event"])) {
		return false;
	}

	const event = message["werpc_event"] as Record<string, unknown>;

	return (
		hasVersion(event) &&
		isBridgeContext(event["context"]) &&
		typeof event["id"] === "number" &&
		typeof event["type"] === "string" &&
		EVENT_TYPES.includes(event["type"])
	);
};

export const isBridgeAnnounce = (message: unknown): message is BridgeAnnounce => {
	if (!isRecord(message) || !isRecord(message["werpc_announce"])) {
		return false;
	}

	const announce = message["werpc_announce"];

	return hasVersion(announce) && typeof announce["namespace"] === "string";
};

export const isBridgeDrop = (message: unknown): message is BridgeDrop => {
	if (!isRecord(message) || !isRecord(message["werpc_drop"])) {
		return false;
	}

	const drop = message["werpc_drop"];

	return hasVersion(drop) && typeof drop["clientId"] === "string";
};
