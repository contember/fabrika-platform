---
id: 0062
title: A platform release runs and deploys applications on older framework releases
status: accepted
date: 2026-10-20
---

# 0062 — A platform release runs and deploys applications on older framework releases

## Context

One repository releases two products under one version. The **framework** (`@fabrika/app`, `@fabrika/db`,
`@fabrika/ui`, `@fabrika/check` and what they import) is a library an application pins. The **platform** (Control,
IAM, the proxy, Operations, the providers) is what an operator installs. An installation upgrades on its operator's
schedule; an application upgrades its framework on its own.

Today the two are coupled to the exact release:

- An application pins the release its installation runs (`reference/release-process.md`, "Pinning the standalone
  example"). Control only warns about another pin (`packages/control/src/mcp/handler.ts:233`).
- Control reads an application's contract with its own reader (`packages/control/src/approval/read.ts`), and derives
  the digest, the proxy manifest and the IAM schema from that read (`packages/control/src/approval/snapshot.ts:91`).
- A Zerops build runs `@fabrika/check` at the installation's version, not the application's
  (`packages/provider-zerops/src/execution.ts:324`).
- At startup the application computes its contract digest with its own framework and refuses to start when it differs
  from `FABRIKA_CONTRACT_DIGEST`, which the platform computed (ADR-0022).

So a platform release that changes the contract language, the artifact or the digest breaks every application that has
not upgraded its framework. Its next deploy is refused by the reader, or its new instance refuses to start. Before 1.0
the framework changes in most minor releases (four minors between 2026-09-07 and 2026-10-16), and the pre-1.0 revision
of the contract kinds in 0.7 deletes whole kinds: forms, file collections, `then` and the generated endpoints
([ADR-0012](0012-fabrika-app-runtime.md) §9). Without a rule, an
installation upgrade forces every application to rewrite its code first.

## Decision

We will keep two compatibility boundaries apart, and hold each to its own rule.

**1. The framework API may break.** What an application's author writes (contract kinds and options, `ctx`, the data
layer, the UI kit, the checker's rules) may change incompatibly in a minor release before 1.0 and in a major release
after it. Such a release carries a migration guide. An application meets the change only when it raises its own pin.

**2. The protocol between an application and the platform does not break inside a support window.** A platform
release deploys and runs every application whose framework release is inside its window. The protocol is everything
one side produces and the other consumes:

- the contract language as the platform reads it, the contract artifact, and the digest;
- the access snapshot, the approval diff over it, and the migration classifier's verdict on the framework bundle;
- the manifest rows the platform compiles for the proxy, and their row modes;
- the headers between the proxy and the application (`X-Fabrika-*`, the proxy secret);
- the claims of every token the application verifies, and the workload key exchange;
- the IAM schema an application registers;
- the variables the platform writes into an application's environment (`FABRIKA_*`);
- the Operations ingest and the source-map upload;
- the build step the platform runs over an application's source.

Framework migrations in the application's own database (the `fabrika` bundle, ADR-0017) are not protocol: the
application's framework release applies its own.

**The window.** A platform release supports every framework minor released in the six months before it, and never
fewer than the two minors before its own. A framework release newer than the platform is refused: the platform is
upgraded first.

**How the platform holds it:**

1. **The artifact is versioned, and the reader of the application's release produces it.** Control reads the
   application's `@fabrika/app` release from the `bun.lock` at the root of the pinned commit (`@fabrika/check` is an
   optional dev dependency) and runs the reader of that release's minor. A commit without a `bun.lock`, or whose
   `bun.lock` does not resolve `@fabrika/app` from the registry, is refused with one line. Each platform release
   bundles, as exact npm aliases, `@fabrika/check`, `@fabrika/app` and `@fabrika/auth-core` at the newest patch of
   every older framework minor in its window, so Control fetches no code at run time, on Bun and in a Worker alike.
   It bundles `@fabrika/proxy-core` of the same releases too: a Zerops namespace whose proxy is pinned to an older
   source runs that release's strict manifest parser, so Control refuses a deploy of a row or a CSP that none of 0.4.8,
   0.5.5 and 0.6.0 parses. No newer minor is a judge while Control does not record a pin's release, because a form
   only it reads would reach a namespace pinned below it (ADR-0022).
   The reader's artifact carries `format: <n>` (a 0.4, 0.5 or 0.6 artifact has none and is format 1). The snapshot
   stores the artifact as its release read it and digests it by that release's canonical form, and the providers write
   that digest into `FABRIKA_CONTRACT_DIGEST` and the proxy table instead of recomputing it, so the application's
   startup check matches.
2. **A patch release never changes the contract language, the artifact or the digest.** That keeps one reader per
   minor sufficient.
3. **The platform upcasts.** Control converts an artifact of any format in the window to its current model, as a data
   migration converts rows. The approval diff compares two upcast artifacts, so an application that raises its pin
   sees its change as an ordinary widening or narrowing.
4. **Protocol changes are additive inside the window.** A new required element follows the order "platform first,
   application after", as the `email` claim does (ADR-0022, rule 6). An element is removed, and a row mode retired,
   only when no format in the window uses it. Until then the proxy, IAM and Control keep serving it.
5. **An upgrade never rewrites a running application.** `fabrika platform upgrade` changes no application's
   descriptor, variables or deployed version. An application changes on its own next deploy.
6. **Below the window, Control refuses the deploy** with one line naming the application's release, the oldest
   supported one and the migration guide. The running version keeps running.
7. **A compatibility suite proves it.** `framework-compat.test.ts` (`packages/control`) reads a fixture of each
   minor in the window through Control's read path: an application installed from npm at that release, with what that
   release's own platform recorded for it. It compares the reader, the contract and snapshot digests, the proxy rows
   and the IAM schema, and the next unchanged deploy shows no change. `examples/crm` in the workspace stays on HEAD
   and is rewritten in the same change as a framework break.
8. **The source version moves first.** A breaking framework minor sets the repository's source version to the next
   minor before anything else. Bun links an `npm:` alias to the workspace when name and version match, so while the
   source said the previous minor, its reader alias would resolve to the working tree instead of npm
   (`reference/release-process.md`).

## Consequences

- An operator upgrades an installation without coordinating with every application team. An application upgrades its
  framework when it chooses, inside six months.
- A framework break costs two steps. The framework drops the old form at once. The platform keeps its side (a row mode,
  a header, a claim, an upcast rule) until the window passes, then deletes it in a release that names what it retired.
- Control and the providers carry one reader per supported minor. The 0.4 reader added 84 KiB gzip to the
  Cloudflare Control bundle (617 KiB with the 0.4 and 0.5 readers).
- The build step changes: a Zerops build runs `@fabrika/check` and `fabrika-source-maps` at the bundled reader's
  release, the newest patch of the application's minor, not at the installation's release and not at the exact patch
  the application pins (`@fabrika/check@0.4.1` has no `fabrika-source-maps`). The snapshot's `checker` names it. The
  Cloudflare build runs no checker.
- The migration classifier may only tighten for migrations an application adds after the platform release. A framework
  bundle migration of a release in the window keeps the verdict it had.
- The MCP authoring rules describe the installation's release. An application pinned to an older one follows the skill
  in its own `node_modules`, as the existing pin warning already says.
- `reference/release-process.md` stops saying that an application installs the release its installation runs. It pins
  an exact release inside the window.
- The approval snapshot's `checker` field (`approval/read.ts`) names the reader that read the commit, and
  `framework` the release the application pins.
- An artifact of an older format is upcast in `packages/control/src/approval/formats.ts`. A 0.4 artifact is read as
  the 0.5 format: 0.5 added only optional fields. A 0.6 artifact is the 0.5 format unchanged: 0.6.0 released the
  framework sources of 0.5.5. A 0.5 job's `timeout` becomes `limits.timeoutMs` (15 min without one) and a 0.5 webhook
  gets the 10 s its handler ran with, so its next deploy shows only what it changed.
- **Rollout path.** No generated installation file, environment variable or provider state changes. The first platform
  release under this rule (0.7) has the window 0.4, 0.5, 0.6 and 0.7, every minor of the last six months that
  published `@fabrika/check`, and bundles the readers 0.4.8, 0.5.5 and 0.6.0. An application on 0.3 or older
  redeploys only after it raises its pin into the window
  ([`framework-migrations.md`](../reference/framework-migrations.md)).

## Alternatives considered

- **Exact coupling (today).** It is the simplest, and it was acceptable while every application was in this
  repository. It makes each installation upgrade a forced framework upgrade for every application, and the first
  breaking revision would break the one production application on its next deploy.
- **The platform reads every old contract language with its current reader.** It needs no bundled readers, but the
  current reader then carries every deleted kind, and the framework cannot delete anything without the platform
  understanding it forever.
- **The application builds and uploads its own artifact.** Control would need no reader at all, but the approval
  (ADR-0050) relies on the platform reading the source at the pinned commit without executing application code. An
  uploaded artifact is an application's claim, not a reading.
- **Control fetches the application's checker from npm at run time.** It needs nothing bundled, but it makes npm a
  dependency of every deploy and runs code a platform release never tested. It does not run in a Worker.
- **No window: support every release forever.** It never forces an upgrade, but every deleted kind lives in the
  platform forever.
