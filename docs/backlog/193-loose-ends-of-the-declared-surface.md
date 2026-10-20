---
id: 193
title: Loose ends of the declared surface
blocked-by: []
---

# 193 — Loose ends of the declared surface

**Summary.** Gaps found while building the 0.7 revision of the contract kinds (ADR-0012 sections 9–16). None blocks
the release; each is a P2 or P3.

## Problem

From the run log of `archive/sprint-2026-10-19-declare-the-surface.md`:

1. **The upgrade approval hides the adoption.** Upgrading a 0.5 application that had a file collection shows "File
   collection `attachments` is removed" and no line that says its files are adopted. The adoption migrations that call
   `fabrika_files_copy_legacy` and `fabrika_files_release` are not marked "needs closer review".
2. **An upcast 0.5 artifact narrows every endpoint's body limit "from none".** The diff shows one narrowing line per
   endpoint on the first 0.7 deploy. The upcast should state the limit the 0.5 runtime applied, so only a real change
   shows.
3. **The upload's time limit reads as 10 s** in the approval diff, while the body may take
   `max(30 s, maxBytes at 16 KiB/s)` before the handler's 10 s start. The line should name both.
4. **The legacy marker.** The reference says the sweep clears the marker of an adopted file; in the local suite the
   marker was already cleared before the sweep ran. Make the doc and the code say one thing.
5. **Admission buckets** are charged one `take` each, not in one admission transaction as ADR-0012 states.
6. **Custom IAM policies** may grant a public procedure's action (ADR-0063 consequence). Decide whether IAM refuses it.
7. **Signed tokens on Cloudflare** are refused: Worker variables are plain text, and no secret path exists.
8. **A namespace proxy pin older than 0.5.3** still breaks on a 0.5 cross-origin field: Control does not record a
   pin's release (backlog 189).
9. **Queues.** A row past `maxAttempts` has no staff path back into the queue; confirm the 30-day backoff cap.
10. **The local compatibility suite** does not run the platform's build step over the old release's source.

From upgrading an application from 0.5.5 to 0.7:

11. **Rolling the platform back.** After a 0.7 deploy, a 0.5.5 or 0.6.0 Control refuses the stored snapshot:
    `Unrecognized key(s) in object: 'framework'`. ADR-0062 covers an older application on a newer platform, not a
    platform rolled back to an older release. Decide whether a rollback is supported. If it is, say how a stored
    snapshot stays readable to the older Control (a reader that ignores unknown keys, or a snapshot written in the
    older shape until the rollback window closes), and test it.
12. **A link procedure cannot always lock its owner.** It holds one action. `ctx.db.target.getForUpdate()` needs the
    owner's table to name that action, and a link procedure cannot declare a second capability. A link that only
    inserts child rows (an upload) therefore cannot count them under the owner's lock (`maxPerOwner` of a 0.5 file
    collection), unless the owner's table names the link's action for another reason. Decide whether a link procedure
    may lock its target under any action the link grants.

## Approach / acceptance

Each item is fixed with a test, or decided and recorded in its ADR (item 11 in ADR-0062). Items 1–3 change the approval diff: a 0.5 → 0.7
upgrade of the local suite's Notes shows an adoption line, no body-limit noise, and the body deadline.

## Touch points

`packages/control/src/approval/`, `packages/control/src/approval/formats.ts`, `packages/app/src/implement/`,
`packages/iam/`, `packages/local-stack/src/compat.ts`, ADR-0012, ADR-0022, ADR-0061, ADR-0063.

<!-- Origin: archive/sprint-2026-10-19-declare-the-surface.md, run log. -->
