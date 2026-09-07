---
id: typed-worker-rpc
kind: pattern
title: Typed SPA-to-Worker RPC boundary
slot: client-worker-api
provides: [typed-rpc, client-worker-api, validated-input, centralized-auth]
requires: [cloudflare, buzola]
recommends: [propustka]
conflicts: []
status: stable
sources:
  - where: "Cloudflare Workers RPC documentation"
    read: "Typed method boundaries, input validation, response envelopes, and centralized authentication."
---

# Typed SPA-to-Worker RPC

## What it is

A small application-owned RPC boundary between a Buzola SPA and its Worker. The
Worker composes a method map; each method owns an input parser and a handler. A
type-only projection of that map gives the browser client fully inferred method
names, inputs and outputs without shipping Worker implementation code.

This is a pattern, not a framework dependency. It keeps the client-rendered stack
small while preserving end-to-end types and one authentication boundary.

## Contract

```ts
interface RpcMethod<Input, Output> {
	input: { parse(value: unknown): Input }
	handle(
		input: Input,
		auth: AuthContext,
		request: Request,
	): Output | Promise<Output>
}

type InferRpcMethods<M> = {
	[K in keyof M]: M[K] extends RpcMethod<infer I, infer O>
		? { input: I; output: Awaited<O> }
		: never
}
```

- The SPA posts `{ method, input }` to one relative endpoint such as `/rpc`.
- The Worker parses JSON, rejects an unknown method, validates input, invokes the
  registered handler and returns either `{ result }` or a typed `{ error }`.
- The client imports the combined method-map type with **`import type`** and
  exposes `callRpc(method, input)` for Buzola loaders plus a stable hook for
  component mutations.
- The Worker authenticates once at the RPC boundary and passes `AuthContext` to
  the selected method. Each method still performs its own `auth.can(...)` check.

## Load-bearing gotchas

- **The client/server bridge must be type-only.** A value import from the Worker
  method registry can pull Cloudflare-only modules and secrets into the browser
  bundle.
- Validate both the envelope and every method input. A TypeScript type is not
  runtime validation; reject malformed JSON/input with 400.
- Method names are an explicit allow-list. Never dispatch an arbitrary property
  path or instantiate a handler from user input.
- Normalize known failures (validation 400, unauthorized 401, forbidden 403,
  not found 404); log unexpected errors server-side and return a safe 500.
- With Propustka, preserve `loginUrl` in the 401 envelope and attach a returned
  `setCookie` to the final RPC response. The SPA redirects a human miss to login
  and guards against redirect loops.
- Use relative `/rpc` URLs. The Vite proxy owns the local backend origin; this
  keeps cookie and request code identical in development and production.

## Feature composition

Keep each feature's methods in a factory/class with constructor-injected ports
(D1 store, queue, provider, clock). Merge their method maps in one
`buildRpcMethods(env, ctx)` composition root and export only the inferred map
type. Unit-test method factories directly with an in-memory/fake AuthContext;
exercise the envelope/auth seam in a smaller set of integration tests.

## Relationships — why

- **requires `cloudflare`** — the server side is the app Worker.
- **requires `buzola`** — the client surface is designed for loaders + SPA
  mutations, not SSR actions.
- **recommends `propustka`** — central boundary authentication plus per-method
  capability checks is the intended secure shape.
