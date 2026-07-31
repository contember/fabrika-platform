---
id: 06
title: Determine whether secret values can be read back from the Zerops API
blocked-by: []
---

# 06 — Determine whether secret values can be read back from the Zerops API

**Summary.** Near-settled. Upstream documentation says values **are** readable with a
write-capable token, which is the token fabrika holds — so plan for the asymmetric
branch. What remains is a live confirmation and the product decision it forces.

## What upstream says

The Zerops environment-variable documentation states it directly: secrets are masked
in the GUI, but **via the API an admin/write token returns the value, and a
read-only token gets `REDACTED`**. Fabrika authenticates with an account-wide
personal access token (`ZEROPS_ACCESS_TOKEN`), so it is on the value-returning side.

That resolves the branch below in favour of "values **can** be read back", and moves
this item from a technical unknown to a product decision: does the dashboard expose
the asymmetry with Cloudflare, or suppress it and stay write-only on both?

Not yet observed on a live account, and not observed for `OutDtoUserData.content`
specifically — which is the exact shape backlog
[`05`](./05-bring-up-on-a-real-zerops-account.md) question #4 asks about.

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
actual response shape for both a write-capable and a read-only token. Acceptance: a
documented answer in
[`../reference/zerops-platform.md`](../reference/zerops-platform.md) with the
endpoint and observed behaviour, plus the decision on whether the dashboard shows the
asymmetry — which the documentation above says is the branch we will be on.

## Touch points

`@fabrika/dashboard`, the Zerops secrets adapter, `../reference/zerops-platform.md`.
