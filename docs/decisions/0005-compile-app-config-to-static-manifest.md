---
id: 0005
title: Compile app config to a static manifest; the control plane never executes app code
status: accepted
date: 2026-10-08
---

# 0005 — Compile app config to a static manifest; the control plane never executes app code

## Context

`fabrika.config.ts` is TypeScript that must be **executed**, not parsed:
`resources({ env })` is a function, so getting an app's resource list means
installing the config's dependencies and running it.

Three separate problems follow:

1. **It forces an evaluation environment onto Zerops.** The Zerops driver is
   otherwise pure HTTP with no filesystem and no shell
   ([ADR-0003](0003-no-deploy-runner-on-zerops.md)). Executing app config would
   drag a whole runtime — install step, module resolution, sandboxing — back in for
   the sole purpose of reading configuration.
2. **It means running a stranger's code with platform credentials in scope.** Once
   "import a public GitHub app" exists, the control plane is executing arbitrary
   third-party TypeScript in a process that holds the Zerops personal access token
   — a token with **account-wide admin privileges**
   ([REST API reference](https://docs.zerops.io/references/api)). That is not a
   sandboxing problem to solve; it is a design to avoid.
3. **Imported repos have no config at all.** A control-plane path that produces a
   resource description _without_ running a `fabrika.config.ts` is required
   regardless — so the executing path was never going to be the only path.

An application's access surface is a different kind of input. It is one contract,
`fabrika.contract.ts`, with its schema modules and the table policies in
`src/db/tables.ts` ([ADR-0012](0012-fabrika-app-runtime.md)). The platform must
enforce it from outside the application ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md))
and approve every widening ([ADR-0050](0050-approved-access.md)). A manifest that
the application's build writes cannot serve that purpose: the build is code an
agent can edit, so its output is the application's self-report. An application
authored over MCP also has no local toolchain to produce it
([ADR-0049](0049-author-applications-through-mcp-in-control.md)).

## Decision

We will add a **`fabrika build`** step that evaluates `fabrika.config.ts` where the
app's own code already runs — in the app's build — and emits
**`fabrika.manifest.json`**.

We will read an application's contract **by static parsing**. Control reads
`fabrika.contract.ts`, the schema modules it imports and `src/db/tables.ts` from the
exact commit of the run. `readContractSource(files)` parses them into the contract
artifact. It accepts only the literal forms of ADR-0012: object and array literals,
strings, numbers, booleans, the known `c.*` and `z.*` calls and `const` imports of
such values. It refuses any other form with the file, the line and the allowed form.
The same reader runs in `fabrika contract check`, in the platform build and in the
checker.

An application's manifest carries no proxy table and no IAM schema. Access data comes
only from the commit.

The control plane reads static JSON and parses literal source. **It never executes
app code.** Parsing evaluates nothing: the reader calls no function of the
application.

The application's startup check is the backstop for the reader. The application
compares its own contract digest with `FABRIKA_CONTRACT_DIGEST` and refuses to start
on a mismatch ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)).

`readContractSource` in `@fabrika/check/contract` is the reader, and the application checker runs it in the
build. Control runs it on the files of each deploy run's pinned commit, which `contractReaderInputs` names
(work unit B6, [ADR-0050](0050-approved-access.md)).

## Consequences

- The control plane's input becomes data it can validate, diff, store, and show in
  a UI — instead of a program whose output depends on when and where it ran.
- The Zerops driver stays pure HTTP.
- **`pipeline.vars` must change shape.** They are currently injected into
  `process.env` _before_ `resources()` runs, so config code can read them. With a
  static manifest they become **`${VAR}` placeholders** interpolated at deploy time.
- **The config language narrows** from arbitrary TypeScript to declarative data with
  interpolation. Anything an app was doing by computing its resource list at config
  time — loops, conditionals on environment, reading a file — must be expressible
  declaratively or move into the build step. This is a real capability loss and the
  main price of the decision.
- A manifest is a build artifact, so it needs versioning and a compatibility story
  between the `fabrika build` that wrote it and the control plane that reads it.
- Imported repos and first-party apps now travel the same path: something produces
  a manifest, the control plane consumes it.
- **The contract language is literal data.** A computed contract is impossible.
  When the literal rule is too restrictive, the reader gains a specific form; it
  never gains evaluation.
- **The static reader and the runtime can disagree.** A differential test compares
  the reader with the evaluated contract on every fixture, and the startup digest
  check fails closed in production.
- **A reader refusal is the agent's feedback.** An agent over MCP sees only the
  build log, so each refusal is one short, actionable line.
- The reader must run in Control on Bun and in a Worker within its size budget.
  It parses with `@babel/parser` (chosen in work unit A7); a Worker bundle of the
  reader is about 153 KiB gzip.

## Alternatives considered

- **Execute `fabrika.config.ts` in the control plane, sandboxed.** Rejected: the
  sandbox has to be strong enough to contain hostile code next to an account-wide
  admin token, and it has to exist on both platforms including the one with no
  filesystem. The security burden is permanent and the failure mode is total.
- **Execute it only on Cloudflare (where a container exists) and require a manifest
  on Zerops.** Rejected: two config semantics, and the more dangerous one is the
  default. Divergence would be discovered by clients, not by tests.
- **Execute it in the deploy runner rather than the control plane.** Better, but
  still rejected: the runner is Cloudflare-only, so Zerops needs the manifest path
  anyway — and once the manifest path exists, the executing path is redundant
  surface area with worse properties.
- **Keep `pipeline.vars` in `process.env` and evaluate lazily at deploy.** Rejected:
  it is the same execution problem with later timing, and it makes the manifest a
  partial artifact — some of the config resolved, some not.
- **Take the access surface from the manifest or an upload.** Rejected: the build
  that writes it is code the agent can edit, so the platform would enforce the
  application's self-report.
- **Evaluate the contract module in a sandbox.** Rejected for the same reasons as
  executing `fabrika.config.ts`, and the contract does not need it: the literal
  rule makes it readable without evaluation.
- **Extend the reader with partial evaluation, such as constant folding.**
  Rejected: each evaluated form is a place where the reader and the runtime can
  disagree. The reader grows only by specific literal forms.
