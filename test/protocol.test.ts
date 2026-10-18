import { describe, expect, it } from "vitest";
import {
	isBridgeAnnounce,
	isBridgeDrop,
	isBridgeEvent,
	isBridgeRequest,
	PROTOCOL_VERSION,
} from "../src/bridge.ts";

const context = {
	clientId: "client-1",
	clientName: "popup",
	namespace: "background",
	tabId: undefined,
	scopeToTab: false,
};

describe("protocol guards", () => {
	it("accepts a well-formed request", () => {
		expect(
			isBridgeRequest({
				werpc_request: {
					v: PROTOCOL_VERSION,
					context,
					id: 1,
					path: "ping",
					type: "query",
					input: undefined,
				},
			}),
		).toBe(true);
	});

	it("accepts a well-formed event", () => {
		expect(
			isBridgeEvent({
				werpc_event: {
					v: PROTOCOL_VERSION,
					context,
					id: 1,
					type: "output",
					output: "pong",
				},
			}),
		).toBe(true);
	});

	it.each([
		"not a message",
		null,
		undefined,
		42,
		{},
		{ werpc_request: null },
		// missing fields
		{ werpc_request: { v: PROTOCOL_VERSION, context, id: 1, type: "query", input: undefined } },
		// malformed context
		{
			werpc_request: {
				v: PROTOCOL_VERSION,
				context: { ...context, clientId: 42 },
				id: 1,
				path: "ping",
				type: "query",
				input: undefined,
			},
		},
		// bad type discriminator
		{
			werpc_request: {
				v: PROTOCOL_VERSION,
				context,
				id: 1,
				path: "ping",
				type: "wat",
				input: undefined,
			},
		},
		// non-numeric id
		{
			werpc_request: {
				v: PROTOCOL_VERSION,
				context,
				id: "1",
				path: "ping",
				type: "query",
				input: undefined,
			},
		},
	])("rejects malformed request %j", message => {
		expect(isBridgeRequest(message)).toBe(false);
	});

	it("ignores messages from other protocol versions", () => {
		expect(
			isBridgeRequest({
				werpc_request: {
					v: 99,
					context,
					id: 1,
					path: "ping",
					type: "query",
					input: undefined,
				},
			}),
		).toBe(false);

		expect(
			isBridgeEvent({
				werpc_event: { v: 99, context, id: 1, type: "output", output: {} },
			}),
		).toBe(false);
	});

	it("validates announce and drop messages", () => {
		expect(
			isBridgeAnnounce({ werpc_announce: { v: PROTOCOL_VERSION, namespace: "popup" } }),
		).toBe(true);
		expect(isBridgeAnnounce({ werpc_announce: { namespace: "popup" } })).toBe(false);
		expect(isBridgeAnnounce({ werpc_announce: { v: PROTOCOL_VERSION } })).toBe(false);

		expect(isBridgeDrop({ werpc_drop: { v: PROTOCOL_VERSION, clientId: "c1" } })).toBe(true);
		expect(isBridgeDrop({ werpc_drop: { clientId: 42 } })).toBe(false);
	});
});
