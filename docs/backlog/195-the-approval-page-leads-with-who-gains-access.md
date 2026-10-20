---
id: 195
title: The approval page leads with who gains access
blocked-by: []
---

# 195: The approval page leads with who gains access

**Summary.** Classification lines carry structured facts (rule, subject, audience, consequence, review reason), and the
approval page groups them by caller and ranks them by effect, review and reach
([ADR-0050](../decisions/0050-approved-access.md) sections 3 and 7). Medium effort, control + contract + dashboard.

## Problem

`classifyAccess` (`packages/control/src/approval/diff.ts`) knows the subject and the caller of every change, but emits
only `{ effect, line, review?: 'closer', environmentOrigins? }`. The approval page (`packages/dashboard/src/routes/approvals/detail.tsx`)
can therefore only list lines in three effect sections. On an agent-authored change of hundreds of lines the few that
matter (an endpoint anyone calls that starts a job) sit among dozens of body-limit narrowings. A closer-review mark
does not say why. After approval the page shows the run status only, not whether the approval lapsed.

## Approach / acceptance

- `AccessChange` gains `rule`, `subject`, `audience` (endpoint subjects), `consequence` and, on closer-review lines,
  `reason`. Every `widening` / `narrowing` / `neutral` / `closerWidening` call site supplies them; the type makes a
  missing one a compile error.
- `classificationSchema` (`packages/control/src/approval/publish.ts`) reads both shapes; a stored line without facts
  stays a plain line.
- A pure grouping function beside `AccessChangeDto` in `@fabrika/control-contract`. Its test holds that it keeps
  every fact and that the widenings visible by default equal the classification's widenings.
- The approval page: impact head, caller groups in `SURFACE_REACHES` order, the data and runtime part, folded rows,
  each public endpoint's effective admission, the reason sentence per closer-review fact, the effect-section list one
  step away, and the post-approval state (waiting to run, published, approval lapsed).

## Touch points

`packages/control/src/approval/{diff,publish,api,surface}.ts`, `packages/control-contract/src/index.ts`,
`packages/dashboard/src/routes/approvals/detail.tsx`, `packages/dashboard/src/lib/access-changes.ts`,
`packages/dashboard/src/__tests__/access-changes.test.ts`.

<!-- Origin: a design review of an access-approval mockup, 2026-10-20. -->
