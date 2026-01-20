import * as v from "valibot";

export interface BridgeContext {
	clientId: string;
	clientName: string | undefined;
	namespace: string;
	tabId: number | undefined;
	scopeToTab: boolean | undefined;
}

export interface BridgeRequestPayload<Input = unknown> {
	idempotencyKey: string;
	context: BridgeContext;
	id: number;
	path: string;
	type: "query" | "mutation" | "subscription.start" | "subscription.stop";
	input: Input;
}

export const bridgeRequestSchema = v.object({
	werpc_request: v.custom<BridgeRequestPayload>(() => true),
});

export type BridgeRequest = v.InferOutput<typeof bridgeRequestSchema>;

export interface BridgeEventPayload<Output = unknown> {
	idempotencyKey: string;
	context: BridgeContext;
	id: number;
	type: "output" | "subscription.ack" | "subscription.output" | "subscription.stop";
	output: Output;
}

export const bridgeEventSchema = v.object({
	werpc_event: v.custom<BridgeEventPayload>(() => true),
});

export type BridgeEvent = v.InferOutput<typeof bridgeEventSchema>;
