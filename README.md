# werpc

Typesafe RPC for Chrome Web Extension (MV3). A thin wrapper over tRPC v11 with a custom link that uses `chrome.runtime.Port` as transport. Lets routers declared in different extension contexts (background service worker, content scripts, popup, options, devtools, offscreen) call each other with full type safety.

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

Any context can be both a server and a client.

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

const unsub = client.background.poll.subscribe(undefined, {
    onData: data => console.log("chunk", data),
    onComplete: () => console.log("done"),
});

// later
unsub();
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

The default `WERPCContext` already provides `tabId?: number` and `clientName?: string`. They are populated automatically by the handler from the request context. Extend it via the generic to add your own fields.

### `createHandler({ namespace, router })`

Registers a tRPC router under a string namespace and starts listening on `chrome.runtime.Port`.

```ts
const handler = createHandler({
    namespace: "background",
    router: t.router({
        ping: t.procedure.query(() => "pong"),
    }),
});
```

Parameters:

- `namespace: string` — unique context name. Clients reference it as `client.<namespace>.<procedure>`.
- `router: AnyRouter` — a tRPC router built with `initWERPC()`.

Behavior:

- Auto-detects its context. In non-service-worker contexts it connects to the SW; in the SW it listens on `chrome.runtime.onConnect`.
- Requests for a different namespace are re-broadcast to other connected ports.
- Subscriptions receive an `AbortSignal` from tRPC; `subscription.stop` from the client aborts the async iterable on the server.
- Runs a keep-alive interval (`chrome.runtime.getPlatformInfo()` every 20s) on each port in the SW to prevent idle shutdown.

### `createClient(options?)`

Returns a proxy object. Accessing a namespace lazily creates a tRPC client for it.

```ts
const client = createClient({ clientName: "popup", scopeToTab: false });

await client.background.ping.query();
await client.background.greet.mutate({ name: "world" });

const unsub = client.background.poll.subscribe(undefined, {
    onData: data => console.log(data),
});
unsub();
```

Options:

- `clientName?: string` — client label, surfaced as `ctx.clientName` on the handler side.
- `scopeToTab?: boolean` — when `true`, responses are delivered only to the port with the same `sender.tab.id`. Use this from content scripts so responses land in the tab that initiated the request.

`createClient` cannot be called from a service worker — it throws. The SW is a handler-only context. To trigger work from the SW, expose procedures on its router and call them from other contexts.

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

`clientName` comes from `createClient` options, `tabId` from `sender.tab.id` of the connecting port (or from an explicit field in the request). Extend via `initWERPC<MyContext>()`.

## Subscriptions

Subscriptions must return an `AsyncIterable` or `Observable`. Returning a plain value throws.

- The client sends `subscription.start` and retries every 1 second until it receives an ack. This survives service worker restarts and port reconnects.
- Calling the returned unsubscribe function, or aborting the tRPC operation's `AbortSignal`, sends `subscription.stop` and aborts the server-side async iterable.

```ts
const unsub = client.background.poll.subscribe(
    {/* input */},
    {
        onData: data => console.log("chunk", data),
        onError: err => console.error(err),
        onComplete: () => console.log("done"),
    },
);

unsub();
```

## Content scripts

Use `scopeToTab: true` so responses are scoped to the tab that sent the request. This matters when multiple tabs run the same content script.

```ts
const client = createClient({ clientName: "content", scopeToTab: true });
```
