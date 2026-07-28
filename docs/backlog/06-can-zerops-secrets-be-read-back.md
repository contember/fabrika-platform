---
id: 06
title: Determine whether secret values can be read back from the Zerops API
blocked-by: []
---

# 06 — Determine whether secret values can be read back from the Zerops API

**Summary.** Open question. The answer decides whether the dashboard's secret UX is
the same on both targets or deliberately different.

## Problem

[ADR-0004](../decisions/0004-secrets-live-in-the-platform.md) makes the platform the
system of record for secret values, so the dashboard reads them (or doesn't) through
the platform's API. Zerops secrets are blurred in the GUI and editable there
([import reference](https://docs.zerops.io/references/import)), but whether the REST
API (`/user-data`, `/project-env`) returns the **value** rather than just the key is
unknown.

- If values **cannot** be read back: the UX is write-only, which is symmetric with
  Cloudflare — one behaviour, one design.
- If values **can** be read back: the dashboard behaves differently per target, and
  we have to decide whether to expose that asymmetry or suppress it.

**Do not guess.** Verify against the live API.

## Approach / acceptance

Call the API with a personal access token against a throwaway project; record the
actual response shape. Acceptance: a documented answer in
[`../reference/zerops-platform.md`](../reference/zerops-platform.md) with the
endpoint and observed behaviour, and a follow-up decision (or ADR) if the answer is
"yes".

## Touch points

`@fabrika/dashboard`, the Zerops secrets adapter, `../reference/zerops-platform.md`.
