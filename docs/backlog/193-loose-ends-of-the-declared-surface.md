---
id: 193
title: Loose ends of the declared surface
blocked-by: []
---

# 193 — Loose ends of the declared surface

**Summary.** Gaps found while building the 0.6 revision of the contract kinds (ADR-0012 sections 9–16). None blocks
the release; each is a P2 or P3.

## Problem

From the run log of `sprints/sprint-2026-10-19-declare-the-surface.md`:

1. **The upgrade approval hides the adoption.** Upgrading a 0.5 application that had a file collection shows "File
   collection `attachments` is removed" and no line that says its files are adopted. The adoption migrations that call
   `fabrika_files_copy_legacy` and `fabrika_files_release` are not marked "needs closer review".
2. **An upcast 0.5 artifact narrows every endpoint's body limit "from none".** The diff shows one narrowing line per
   endpoint on the first 0.6 deploy. The upcast should state the limit the 0.5 runtime applied, so only a real change
   shows.
3. **The upload's time limit reads as 10 s** in the approval diff, while the body may take
   `max(30 s, maxBytes at 16 KiB/s)` before the handler's 10 s start. The line should name both.
4. **The legacy marker.** The reference says the sweep clears the marker of an adopted file; in the local suite the
   marker was already cleared before the sweep ran. Make the doc and the code say one thing.
5. **Admission buckets** are charged one `take` each, not in one admission transaction as ADR-0012 states.
6. **Custom IAM policies** may grant a public procedure's action (ADR-0063 consequence). Decide whether IAM refuses it.
7. **Webhooks.** `{ basic }` and `{ bearer }` are refused because the proxy strips `Authorization` on anonymous rows
   (ADR-0022 rule 3). Providers that issue their own secret (Stripe, Standard Webhooks) need a set-secret operation.
   Slack and Twilio signatures do not fit `{ hmac }`. Inbound mail with attachments exceeds the 1 MiB webhook ceiling.
8. **Signed tokens on Cloudflare** are refused: Worker variables are plain text, and no secret path exists.
9. **A namespace proxy pin older than 0.5.3** still breaks on a 0.5 cross-origin field: Control does not record a
   pin's release (backlog 189).
10. **Queues.** A row past `maxAttempts` has no staff path back into the queue; confirm the 30-day backoff cap.
11. **The local compatibility suite** does not run the platform's build step over the old release's source.

## Approach / acceptance

Each item is fixed with a test, or decided and recorded in its ADR. Items 1–3 change the approval diff: a 0.5 → 0.6
upgrade of the local suite's Notes shows an adoption line, no body-limit noise, and the body deadline.

## Touch points

`packages/control/src/approval/`, `packages/control/src/approval/formats.ts`, `packages/app/src/implement/`,
`packages/iam/`, `packages/local-stack/src/compat.ts`, ADR-0012, ADR-0022, ADR-0061, ADR-0063.

<!-- Origin: sprints/sprint-2026-10-19-declare-the-surface.md, run log. -->
