---
id: 240
title: Channel prereleases sort below the release floors
blocked-by: []
---

# 240 — Channel prereleases sort below the release floors

**Summary.** A `0.9.0-cloudflare.<n>` cut from current `main` carries the application object's alarm, job segment cap,
data operations, raw SQL and Postgres through Hyperdrive, but the Cloudflare gates deny all five to an application
pinned to it. A decision is needed before the next channel release; this item does not make it.

## Problem

The Cloudflare release floors (`releaseFrom` in `packages/provider-cloudflare/src/contract-support.ts`:
`servesAlarms`, `capsJobSegments`, `servesDataOperations`, `servesRawSql`) compare SemVer precedence against
`0.9.0-dev.5`, and `servesPostgresDatabase` against `0.9.0-dev.9`. SemVer orders prerelease identifiers by ASCII, so
every `0.9.0-cloudflare.<n>` and `0.9.0-alpha.<n>` sorts below both. The floors are right for `cloudflare.1`–`cloudflare.2`,
which predate those features, but `cloudflare.3` (cut after `dev.8`) already has the first four and is read as the
older behaviour: the deploy refuses `sql`, the Worker keeps the minute tick, and Control's data operations are refused.
A channel release cut from a `main` with Postgres would have its own Control, `buildJob` and deployer refuse its
`database`.

Control's window check (`readerFor` in `packages/control/src/approval/readers.ts`) compares only major.minor.patch,
so a platform at one prerelease accepts an application pinned to a later prerelease of the same version and reads it
with its own reader. Making it prerelease-aware has the same channel-ordering problem (a `cloudflare.<n>` platform
would refuse every `dev.<n>` application), so it waits for this decision. Until then a feature a newer prerelease adds
to the application side must fail closed on an older platform by itself: Postgres does, because the application's CLI
writes its entry only when the deployer passes `--database=postgres`, which no older deployer does. A platform at
`0.9.0-dev.0`–`dev.4` runs no entry build and deploys a committed `fabrika/entry.generated.ts` as it is, so there only
an application that commits a Postgres entry gets past the CLI's refusal; making `readerFor` prerelease-aware closes
that too. The minor gates
(`releaseAtLeast`) do not have this problem; they count every 0.9.0 prerelease alike
([release-process.md](../reference/release-process.md#release-channels)).

## Approach / acceptance

Decide one of, before cutting the next channel release:

- **A version that sorts above the floor.** Cut channel releases with a version that SemVer orders at or above the
  floor (another base version, or a prerelease identifier that sorts after `dev`). Costs: the channel's version no
  longer reads as "this release, cloudflare channel", and `release:bump`'s channel-switch rule
  (`scripts/release.ts`) may need to follow.
- **Per-channel floors.** A floor names the first release of each channel that ships the feature (`dev.5`,
  `cloudflare.<n>`), and a release of an unknown channel fails closed. Costs: every new floor must be set per channel,
  and the gate stops being one SemVer comparison.

Related: [228](228-application-object-review-follow-ups.md) item 31 (`servesOps` must not gate by SemVer order alone).
Acceptance: a `contract-support.test.ts` case for the next channel release that passes every floor its code meets, and
the published `cloudflare.1`–`cloudflare.3` still pass none.

## Touch points

`packages/provider-cloudflare/src/contract-support.ts` (every `releaseFrom` floor, `servesPostgresDatabase` included)
and its test, `packages/provider-cloudflare/src/__tests__/published-prereleases.ts`, `packages/control/src/approval/readers.ts`
(`readerFor`'s newer-than-the-platform check), `scripts/release.ts` (`RELEASE_CHANNELS`, the bump's ordering rule),
`docs/reference/release-process.md`.
