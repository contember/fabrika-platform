---
id: 281
title: The review proxy binds a name, not an address
blocked-by: []
---

# 281 — The review proxy binds a name, not an address

**Summary.** The `agent-canvas` review proxy listens on `localhost` and prints a `localhost` URL. Where `localhost`
resolves to both `127.0.0.1` and `::1`, a client can connect to another server holding the same port on the other
family. Bind one address, and print that address in the URL. Small.

## Problem

`ReviewProxies.serve` (`packages/agent-canvas/daemon/src/review/proxy.ts`) binds `hostname: 'localhost'`, and `open`
returns `http://localhost:<port>/…`. Bun's listener resolves the name and prefers IPv6 when both families resolve, so
the proxy listens on `::1` only. A client that tries `127.0.0.1` first reaches whatever holds `127.0.0.1:<port>`, if
anything does.

- **Tests:** in one `bun test` process, a server another test file left running can hold that port. The proxy tests
  would then read its answer instead of the proxy's.
- **A reviewer's machine:** another local service on that port would answer in the proxy's place.

The review test's own application already binds `127.0.0.1` for the same reason.

## Approach / acceptance

- The proxy binds `127.0.0.1` and prints `http://127.0.0.1:<port>/…`. Alternatively, it binds both families on one port.
- A restarted daemon keeps the port it stored.
- Check what a reviewer's browser keys on the origin before changing it: storage, the widget script's origin, and
  `isLoopbackOrigin`.
- The proxy tests reach it by that address.
