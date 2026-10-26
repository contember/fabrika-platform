---
id: 240
title: Channel prereleases sort below the release floors
blocked-by: []
---

# 240 — Channel prereleases sort below the release floors

**Summary.** A `0.9.0-cloudflare.<n>` cut from current `main` carries the application object's alarm, job segment cap,
data operations and raw SQL, but the Cloudflare gates deny all four to an application pinned to it. A decision is
needed before the next channel release; this item does not make it.

## Problem

The Cloudflare release floors (`releaseFrom` in `packages/provider-cloudflare/src/contract-support.ts`:
`servesAlarms`, `capsJobSegments`, `servesDataOperations`, `servesRawSql`) compare SemVer precedence against
`0.9.0-dev.5`. SemVer orders prerelease identifiers by ASCII, so every `0.9.0-cloudflare.<n>` and `0.9.0-alpha.<n>`
sorts below `0.9.0-dev.5`. The floors are right for the channel releases already published (`cloudflare.1`–`cloudflare.2`
predate those features), but a channel release cut from a `main` that has them is still read as the older behaviour:
the deploy refuses `sql`, the Worker keeps the minute tick, and Control's data operations are refused. The minor gates
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
the published `cloudflare.1`–`cloudflare.2` still pass none.

## Touch points

`packages/provider-cloudflare/src/contract-support.ts` and its test, `packages/provider-cloudflare/src/__tests__/published-prereleases.ts`,
`scripts/release.ts` (`RELEASE_CHANNELS`, the bump's ordering rule), `docs/reference/release-process.md`.
