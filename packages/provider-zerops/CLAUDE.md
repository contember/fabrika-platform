# @fabrika/provider-zerops

The Zerops provider bundle: app authoring (`defineApp`), the `zerops-import.yaml` compiler, the typed
REST client, the deploy plan, deployment namespaces, and the control-side provider. Assumes the root
CLAUDE.md. A Zerops deploy is HTTP calls and nothing else — there is no runner (ADR-0003).

**Read [`docs/reference/zerops-platform.md`](../../docs/reference/zerops-platform.md) before changing
anything here.** It records facts settled against a real account, several of which contradict Zerops'
published documentation. Do not re-derive them.

## Commands (this package)

```bash
bun run gen:schema   # regenerate src/schema.generated.ts from Zerops' published JSON schema
bun test
```

## Invariants

- **`src/schema.generated.ts` is GENERATED — never edit it by hand.** It is a faithful transcription
  of the platform contract (a 202-value service-type enum and a nested `zerops.yaml` object, both of
  which move whenever Zerops adds a runtime version). It is deliberately NOT the authoring surface:
  what an app may declare is `src/types.ts`, which SUBTRACTS the fields fabrika owns.
- **ADR-0004's two invariants are enforced structurally at three layers in `src/compile.ts`**, so
  "someone forgot" is not a reachable state: the TYPES make `envIsolation`, `envSecrets`,
  `dotEnvSecrets`, `override`, and project-level `envVariables` unauthorable; the compiler BUILDS
  each entry rather than copying and patching, writing `envIsolation: 'service'` itself from the one
  construction site; and `assertZeropsInvariants` checks every document before serialization. The
  failure prevented is concrete — with `envIsolation: none` (legal, and not reliably the default)
  every service sees every other service's variables, so one app's credentials leak to another.
- **The compiler is PURE** — no network, no filesystem, no clock.
- **Unverified API behavior stays marked `UNVERIFIED:`.** Every shape in `src/api.ts` was read off
  Zerops' published OpenAPI document; the log service and a handful of behaviors were not. Do not
  quietly promote one to fact — check it against a real account first.
- **The API token is a PERSONAL ACCESS TOKEN with account-wide admin rights.** Never log it, never
  put it in an error message, never return it from a method.
- **Service hostnames are constrained** (`^[a-z0-9]{1,25}$`). Shared-namespace names are derived
  deterministically from the app id (`src/service-names.ts`) — do not hand-build one.
- **Persisted target envelopes hold coordinates only.** Credentials are composed for a live run.
- **The control provider requires an injected `execute` collaborator** (`@fabrika/engine` supplies
  it). Never add a provider-local fallback lifecycle.
