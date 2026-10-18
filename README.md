# werpc

Typesafe RPC for Chrome Web Extensions (MV3). A thin wrapper over tRPC v11 with a custom link that uses `chrome.runtime.Port` as transport. Lets routers declared in different extension contexts (background service worker, content scripts, popup, options, devtools, offscreen) call each other with full type safety.

## Install

```bash
npm install werpc
# or
yarn add werpc
# or
pnpm add werpc
```

Requires a Chrome Extension MV3 environment with `chrome.runtime` available.

## How it works

Every extension context that wants to participate does two things:

1. Registers its own router under a string namespace via `createHandler`.
2. Optionally creates a client via `createClient` and calls procedures of other namespaces.

Any context can be both a server and a client — **except the service worker, which is a handler-only context** (see [Service worker limitations](#service-worker-limitations)).

The service worker acts as the message router:

- non-SW handlers announce their namespace over their port when they start (and re-announce after SW restarts);
- each request is routed to exactly one owner of the target namespace;
- responses are delivered point-to-point to the port the requesting client lives on.

Namespaces are registered globally via TypeScript declaration merging, so the client is fully typed across all contexts in the project.

## Quick start

Define a router and register it under a namespace in any extension context:

```ts
// background.ts
import { initWERPC, createHandler, type InferNamespace } from "werpc";

const t = initWERPC();

export const handler = createHandler({
    namespace: "background",
    router: t.router({
        ping: t.procedure.query(
            ({ ctx }) => `pong (tab: ${ctx.tabId}) (client: ${ctx.clientName})`,
        ),
        greet: t.procedure
            .input(value => (typeof value === "string" ? value : undefined))
            .query(({ input }) => `hello, ${input}`),
        poll: t.procedure.subscription(async function* ({ signal, ctx }) {
            for (let i = 0; !signal?.aborted && i < 4; i++) {
                yield { i, tab: ctx.tabId };
                await new Promise(r => setTimeout(r, 1000));
            }
        }),
    }),
});

declare module "werpc" {
    interface WERPCNamespaces extends InferNamespace<typeof handler> {}
}
```

Call it from another context:

```ts
// popup.ts
import { createClient, initWERPC, createHandler, type InferNamespace } from "werpc";

const t = initWERPC();

// register this context's own namespace too
const handler = createHandler({
    namespace: "popup",
    router: t.router({
        getState: t.procedure.query(() => ({ open: true })),
    }),
});

declare module "werpc" {
    interface WERPCNamespaces extends InferNamespace<typeof handler> {}
}

const client = createClient({ clientName: "popup" });

const pong = await client.background.ping.query();
const hello = await client.background.greet.query("world");

const subscription = client.background.poll.subscribe(undefined, {
    onData: data => console.log("chunk", data),
    onComplete: () => console.log("done"),
});

// later
subscription.unsubscribe();
```

Repeat the same pattern for `content.ts`, `options.ts`, `devtools.ts`, `offscreen.ts` — each registers its own namespace and can call any other.

## API

### `initWERPC<TContext, TMeta>()`

Wraps `initTRPC.context<TContext>().meta<TMeta>().create({ isServer: false, allowOutsideOfServer: true })`. Returns the standard tRPC builder (`router`, `procedure`, etc.).

```ts
interface MyContext {
    tabId?: number;
    clientName?: string;
    userId?: string;
}

const t = initWERPC<MyContext>();
```

The default `WERPCContext` already provides `tabId?: number` and `clientName?: string`. They are populated automatically: `clientName` comes from `createClient`, `tabId` is the tab of the context that made the call. Extend via the generic to add your own fields.

### `createHandler({ namespace, router })`

Registers a tRPC router under a string namespace.

```ts
const handler = createHandler({
    namespace: "background",
    router: t.router({
        ping: t.procedure.query(() => "pong"),
    }),
});
```

Behavior:

- In the service worker: registers the namespace with the in-context router and listens on `chrome.runtime.onConnect`.
- In any other context: opens a port to the service worker, announces the namespace and serves requests for it. Announces are re-sent automatically after SW restarts.
- Requests for other namespaces are never executed by your context — the SW routes them to the owning context.
- Errors thrown by procedures (including invalid paths) are delivered to the caller as tRPC errors.
- `handler.dispose()` unregisters the namespace, aborts its subscriptions and closes the port.

**Multiple contexts may register the same namespace** (e.g. a content script in several tabs). A request is routed to exactly one owner:

- if the caller set `scopeToTab: true` and the target namespace has an owner in the caller's tab, that owner wins;
- otherwise the first registered owner wins (deterministic, but you should not rely on which tab it is).

### `createClient(options?)`

Returns a proxy object. Accessing a namespace lazily creates a tRPC client for it.

```ts
const client = createClient({ clientName: "popup", scopeToTab: false, timeoutMs: 30_000 });

await client.background.ping.query();
await client.background.greet.mutate({ name: "world" });

const subscription = client.background.poll.subscribe(undefined, {
    onData: data => console.log(data),
});
subscription.unsubscribe();
```

Options:

- `clientName?: string` — client label, surfaced as `ctx.clientName` on the handler side.
- `scopeToTab?: boolean` — when `true`, requests prefer a handler living in the caller's tab. Use this from content scripts (and devtools panels, where the inspected tab is detected automatically).
- `timeoutMs?: number` — fail queries/mutations after this long (default 30 000, `0` disables). Timeouts reject with a `TRPCClientError`.

`createClient` cannot be called from a service worker — it throws. The SW is a handler-only context. To trigger work from the SW, expose procedures on its router and call them from other contexts, or have other contexts subscribe to SW subscriptions.

`client.dispose()` closes the underlying port; further calls throw.

### `InferNamespace<THandler>`

Utility type that turns `WERPCHandler<"foo", TRouter>` into `{ foo: TRouter }`. Used to register a namespace in the global registry:

```ts
declare module "werpc" {
    interface WERPCNamespaces extends InferNamespace<typeof handler> {}
}
```

Place this declaration in the entry point of the context that owns the namespace. It must load before any client uses that namespace.

### `WERPCContext`

Default tRPC context:

```ts
interface WERPCContext {
    tabId?: number;
    clientName?: string;
}
```

`tabId` is the tab of the **caller** (undefined for popup/options/SW callers), `clientName` comes from `createClient` options.

## Errors

- A throwing procedure rejects the caller's promise with a `TRPCClientError` (and fires `onError` for subscriptions), including its tRPC error code.
- Calling a procedure that does not exist rejects with `NOT_FOUND`.
- Calling a namespace whose context is not open rejects with `NOT_FOUND: Namespace not found: <name>` — unless the owning context connects within a short grace window (covering SW restarts).
- If the owning context dies mid-request, the caller gets an error; if the client port dies, the service worker aborts the server-side subscription automatically.

## Subscriptions

Subscriptions must return an `AsyncIterable` or `Observable`. Returning a plain value throws.

- The client sends `subscription.start` and retries with backoff (1s / 2s / 5s cap) until it receives an ack. This survives service worker restarts and port reconnects; duplicate starts are re-acked, not re-subscribed.
- Calling `subscription.unsubscribe()` (or aborting the tRPC operation) sends `subscription.stop` and aborts the server-side async iterable. When the iterable finishes on its own, the client's `onComplete` fires.
- The service worker is kept alive while any subscription is active (a `chrome.runtime.getPlatformInfo()` heartbeat every 20s); it may idle-shutdown when only queries/mutations are in flight, which is fine — queries transparently re-establish ports.

## Serialization

Messages travel over `chrome.runtime.Port` using structured clone. Anything structured-cloneable (Dates, Maps, Sets, ...) works. tRPC transformers (e.g. superjson) are **not** applied by this transport.

## Protocol

Wire messages carry a `v` field (`PROTOCOL_VERSION`). Messages with an unknown version are ignored, so an extension update window where an old content script talks to a new service worker degrades to "namespace not found" instead of garbage execution.

## Testing

- `pnpm test` — unit/integration suite running against a fake `chrome.runtime` port hub (routing, errors, timeouts, reconnect races, leak checks).
- `pnpm play:e2e` — Playwright e2e suite that loads the built playground extension into real Chromium (cold SW start, all contexts, subscriptions). Set `PW_HEADLESS=1` for headless runs (CI uses it).

## Service worker limitations

- `createClient` throws in the SW: the SW cannot initiate RPC calls, it can only serve them.
- The router state (namespace ownership, client ports) lives in the SW's memory. On SW restart, contexts re-announce automatically; in-flight queries fail with a timeout and must be retried by the caller.
