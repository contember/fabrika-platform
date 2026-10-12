---
id: 128
title: A public page cannot read a public configuration value
blocked-by: []
---

# 128 — A public page cannot read a public configuration value

**Summary.** A public page needs values that are public but differ per environment: the challenge widget's site key,
or the URL of a link target. No way to get them to the page exists, so the page holds them as build-time constants,
and each environment needs its own build. Effort: S.

## Problem

The skill says that the page "renders the Turnstile widget with its public site key"
(`packages/app/skill/references/public-intake.md:563`), but not where the key comes from. A public page calls no
procedure, and application variables reach only the server (`defineDeps`). The one browser-readable source is
`<prefix>/__fabrika-config.json`, which holds only the Operations DSN and the release (`BrowserConfig`,
`packages/app/src/implement/dispatch.ts:199`–`:201`, served at `:314`–`:317`, built at `boot.ts:780`). The dogfood
compiled the widget's test key and its link targets into the page.

## Approach / acceptance

- A form's challenge names its site key's variable beside its secret:
  `challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey: 'TURNSTILE_SITE_KEY' }`. An SPA mount may
  list other public variables (`public: ['SIGNUP_URL']`).
- `__fabrika-config.json` serves the declared values of the mount only. The contract carries the names, so the
  approval shows each one (ADR-0050). A variable named both as a secret and as public is refused at compile.
- Witness: a dispatch test in which the config file holds the declared values and no other variable, and a compile
  test of the refusal. The recipe's page reads its site key from the file.

## Touch points

`packages/app/src/contract/{define.ts,build.ts,artifact-schema.ts}`, `packages/app/src/implement/{boot.ts,dispatch.ts}`,
`packages/app/skill/references/public-intake.md`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood). -->
