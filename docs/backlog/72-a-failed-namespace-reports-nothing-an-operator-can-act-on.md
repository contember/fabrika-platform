---
id: 72
title: A failed namespace reports nothing an operator can act on
blocked-by: []
---

# 72 — A failed namespace reports nothing an operator can act on

**Summary.** Namespace provisioning discards the provider's error, so every failure looks identical
from the API, the console and the database. Diagnosing the first real one meant re-running the provider
by hand against the live account. Effort S.

## Problem

`mutateNamespace` catches everything the provider raises, throws away `cause`, and stores a message
that names only the operation (`packages/control/src/api/namespaces.ts:171-181`):

```ts
} catch (cause) {
  if (isDomainError(cause)) throw cause
  const message = `namespace ${mutation} failed`
  await c.repositories.registry.updateDeploymentNamespace({ id: row.id, state: 'failed', lastError: message })
  fail(502, message)
}
```

`cause` is not logged either, so nothing downstream can recover it. Three genuinely different live
failures — a `403 insufficientPermissions` on project import, a `400 invalidUserInput` on a service
variable write, and a `serviceStackIsNotHttp` on subdomain publication — all surfaced as the same
`namespace provision failed` with the same 502. Each took a hand-written reproduction to identify.

The reticence is deliberate in spirit: a provider error can quote an upstream body, and ADR-0004's
neighbours are careful never to leak a credential into a message. But the current behaviour is not
redaction, it is deletion.

## Approach / acceptance

Keep the API's generic message. Add a redacted, bounded diagnostic the operator can actually read —
a log line at minimum, and preferably a stored `lastErrorDetail` the console renders — carrying the
provider's error CLASS and any platform error code, never its response body, URL or any value that
came off the wire. `ZeropsApiError` already separates `code` from detail, so the code is the natural
thing to keep.

Witness: a test that drives a namespace mutation into each of an authorization failure, a validation
failure and a transient failure, and asserts the operator-visible record distinguishes them while
containing neither a credential nor an upstream body.

## Touch points

`packages/control/src/api/namespaces.ts`, the namespace row shape and its migration,
`packages/dashboard/src/routes/namespaces/detail.tsx`.

<!-- Origin: found while provisioning the first live app namespace, 2026-08-18. -->
