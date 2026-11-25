---
id: 304
title: A requested key can outlive its request, and its tests miss three paths
blocked-by: []
---

# 304 — A requested key can outlive its request, and its tests miss three paths

**Summary.** These are the minor findings of the step 7b review (ADR-0083 §8). They cover two ways a key nobody holds
stays valid until its expiry (at most 30 days), IAM's encrypted copy that is never cleared, and test gaps. None of them
discloses a key. Low severity, about 2–3 agent hours.

## Problem

- **A lease that expires mid-call.** The IAM call in `packages/control/src/approval/requests/kinds/keys.ts` does not
  take `execution.signal`.
  - If the lease expires during a slow IAM call, the sweep marks the request `unknown`. IAM has no row yet, so the
    request closes `failed`, and then the late call commits a key.
  - If the executor survives, it writes the delivery row and the deadline sweep revokes the key.
  - If it crashes in between, the key stays valid until it expires.
- **A delivery used up by another credential.** A request made with a key has no OAuth client. Another clientless
  credential of the same principal can fetch the delivery first. The key then counts as fetched and is never revoked.
  This is documented as a known gap.
- **IAM's encrypted copy.** IAM keeps the JWE in `requested_api_keys` after Control's copy is fetched or expired, and
  `apiKeys.requested` answers it to any `iam.admin` caller. It is useless without the private key, but nothing clears
  it.
- **Test gaps** (`packages/control/src/__tests__/approval-agent-keys.test.ts`, `packages/iam/src/__tests__/requested-api-keys.test.ts`):
  - the issued key is not shown to be authorized by Control at `app:<id>`; the test checks the token's claims only;
  - no test encrypts to an X25519 key;
  - IAM's concurrent repeat is not tested (the catch in `admin/api-keys.ts`);
  - a `px_` key with `iam.admin` is not tested against `provisionRequested`, only the provisioning key.

## Approach / acceptance

- The IAM call takes the execution's signal. As well, the sweep revokes, by request id, a key that IAM issued for a
  request closed `failed`. A test commits the key after the request closed and sees it revoked.
- IAM clears `jwe` once the key has expired or Control reports the delivery fetched. A test reads the row afterwards.
- The four tests above.

## Touch points

- `packages/control/src/approval/requests/kinds/keys.ts`
- `packages/control/src/approval/requests/deliveries.ts`
- `packages/iam/src/admin/api-keys.ts`
- `packages/iam/src/cron.ts`
- the two test files

<!-- Origin: the review of step 7b of ../ideas/agent-requested-approvals.md (PR #440, round 1). -->
