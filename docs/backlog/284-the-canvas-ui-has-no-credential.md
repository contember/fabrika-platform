---
id: 284
title: The agent-canvas browser UI has no credential
blocked-by: []
---

# 284 — The agent-canvas browser UI has no credential

**Summary.** The `agent-canvas` daemon admits only loopback `Host` values, same-origin browser requests and, on CLI
routes, the CLI capability. The routes its own browser UI calls still take no credential, so any local client that
sends no `Origin` reaches them. Give the UI a per-daemon credential. Effort: M.

## Problem

`admitRequest` (`packages/agent-canvas/daemon/src/admission.ts`) refuses a foreign `Host`, a cross-site `Origin` on a
request that changes state or upgrades to a WebSocket, and a CLI route without `X-Agent-Canvas-CLI-Token`. The file
routes refuse the daemon's own `TEMP_DIR` and `DATA_DIR`. What is left open is every route the UI calls: a process of
another OS user on the same machine can connect to the loopback port without an `Origin` and read
`/api/file`/`/api/tree`/`/api/image` (inside a session's project root, plus the absolute paths its canvases name),
list `/api/sessions` with their project
roots, read session metadata and feedback, store or clear a `SecretInput` value, upload, share a revision, and open
`/ws/session/:id`. It cannot resolve a secret or consume feedback any more; those need the CLI capability.

## Approach / acceptance

- The daemon generates a UI secret next to the CLI capability (mode `0600`). Keep it in `DATA_DIR`, so a restarted
  daemon keeps open tabs working, or rotate it per daemon and let the page say how to get a new link.
- Bootstrap: the `browserUrl` the plan route returns (already behind the CLI capability) carries a one-time code. The
  daemon answers `/s/:id?code=…` by setting an `HttpOnly; SameSite=Strict; Path=/` cookie and redirecting to the clean
  URL. A plain `/s/:id` without the cookie shows a page that names the CLI command printing a fresh link (a new
  `agent-canvas open [--session]`).
- `admitRequest` requires the cookie, or the CLI capability, on every `/api/*` route and `/ws/session/*`, except
  `/health`, `/assets/*` and the review routes. Shared-mode pages (`/s/:shareId/feedback`) keep working.
- Review widget routes are called from other loopback ports and keep their own origin check; decide whether they also
  need the credential (the proxy could inject it into the widget tag) or hold nothing worth it.
- Witness: an absolute `/api/file`, `/api/sessions` and a `/ws/session` upgrade without the cookie answer 401; the
  bootstrap sets the cookie and the same requests succeed; the CLI flow (`push`, `watch`, `exec --secret`) still works.

## Touch points

`packages/agent-canvas/daemon/src/{admission.ts,server.ts,handlers/static.ts,handlers/api.ts}`,
`packages/agent-canvas/bin/lib/commands/`, `packages/agent-canvas/README.md`.
