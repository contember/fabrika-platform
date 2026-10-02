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
- **Deploy-time variables are substituted into the DOCUMENT, never into rendered YAML.**
  `interpolateManifest` (`src/provider.ts`) walks the import document's string leaves and returns a new
  document; `renderYaml` runs after it, so a value carrying `"`, a newline or `- hostname:` is emitted as
  a scalar and stays data — the `|-` block form is used ONLY for text that survives it (`blockScalarSafe`
  in `src/compile.ts`), everything else is JSON double-quoted. **That guarantee is stated against a YAML
  1.1 reader**, because Zerops parses with go-yaml: 1.1 ends a line on NEL/LS/PS and refuses a raw C1
  control, and Bun's 1.2 reader does neither. So `isYamlHostileCodePoint` keeps those out of a block and
  the double-quoted form escapes them `\uXXXX` (keys included — they share `scalar()`). Never certify the
  emitter with `Bun.YAML.parse` alone: it cannot see the difference, so assert on the rendered TEXT.
  Substitution then re-runs
  `assertZeropsInvariants`, refuses a value that moved a service's `hostname`/`type`/`envIsolation`/
  `override` or anything in `project`, refuses a placeholder in a key or one a value carried in, and
  refuses a value naming a foreign service. Never splice a value into the YAML text: every structural
  check in this package runs on the object.
- **`override: true` goes on EVERY service, managed ones included, and it is not an update.** Live-verified:
  without it a re-apply is `400 serviceStackNameUnavailable` and the whole document fails; with it an
  existing service is left exactly as it is, so a changed `profile`/`maxContainers`/`objectStorageSize`
  is silently ignored. `assertZeropsInvariants` refuses a document missing it. Never describe the
  steady-state import as "reconciling"; change a live field through the API that owns it.
- **`compileProvisioningYaml`'s output is first-bring-up only.** Re-applying it at a service that carries
  code activates an EMPTY app version and demotes the running one to `BACKUP`.
- Application registration uses `renderFabrikaProvisioningYaml` with `override: false` to refuse
  first-creation collisions (ADR-0044). Preserve `override: true` in the canonical manifest and
  steady-state imports; await every returned import process before completing registration.
- **An import document CANNOT establish a `.zerops.app` subdomain** — `enableSubdomainAccess` is accepted
  and dropped, on a service the document creates as much as on one `override` leaves alone. Only
  `PUT /service-stack/{id}/enable-subdomain-access` does, and only once the service publishes a DEPLOYED
  HTTP port (`400 serviceStackIsNotHttp` before that). Its 2xx proves nothing — on an already-published
  service it returns a process that then fails — so decide by reading `subdomainAccess` back.
  `ensureSubdomainAccess` in `src/namespace/provisioning.ts` is the one place that does this; it runs after the proxy
  deploy, on reconcile too, and throws rather than leaving a namespace with no public entry point.
- **The published `zerops.yaml` schema is wrong about the six probe durations** (`integer`; the platform
  wants a Go duration string in `[10s, 1h]`). `src/types.ts` carries the corrected `ZeropsDuration` and
  the `*Spec` authoring types — do NOT try to fix `schema.generated.ts`.
- **The compiler is PURE** — no network, no filesystem, no clock.
- **Unverified API behavior stays marked `UNVERIFIED:`.** Every shape in `src/api/types.ts` was read off
  Zerops' published OpenAPI document; the log service and a handful of behaviors were not. Do not
  quietly promote one to fact — check it against a real account first.
- **The API token is a PERSONAL ACCESS TOKEN with account-wide admin rights.** Never log it, never
  put it in an error message, never return it from a method.
- **Service hostnames are constrained** (`^[a-z0-9]{1,25}$`). Shared-namespace names are derived
  deterministically from the app id (`src/service-names.ts`) — do not hand-build one.
- **A `${host_KEY}` reference may name only the app's OWN declared hostnames plus the namespace's shared
  services** (`src/service-references.ts`) — Zerops resolves one across services whatever `envIsolation`
  says. `parseFabrikaManifest` refuses a foreign host anywhere in a declared service or in the PARSED
  `sourceDescriptor`; never scan that as text, because a folded break, a `\x24` escape or a block scalar
  hides a reference the text does not spell. Hostnames are never rewritten at deploy. The rule covers every
  app-supplied path into a service's env — the manifest, `interpolateManifest`, and `secrets.put`
  (`src/control.ts`), which lands on the same resolver.
- **Persisted target envelopes hold coordinates only.** Credentials are composed for a live run.
- **The control provider requires an injected `execute` collaborator** (`@fabrika/engine` supplies
  it). Never add a provider-local fallback lifecycle.
