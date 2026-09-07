---
name: fabrika-build-orchestrator
description: >
  Phase 8 (build) playbook. The MAIN Fabrika session reads this and drives the
  build: it does NOT hand-code the whole DAG — it fans out implementer
  subagents directly (one per issue, in isolated git worktrees), supervises them, gates
  each on a green opice `bun test`, guards the frozen invariants, and escalates
  blocked issues to a final review. The concrete work list is the induced issue
  DAG, read live from `fabrika builder build status` / `.fabrika/issues/ISSUE-*.md` — this
  file is the METHOD and the files are the DATA.

  Use this when a `fabrika builder next` packet reaches the build phase, or the user asks
  to "build it" / "implement the issues" for a Fabrika project. The build is
  agent-assisted: the user stays in the loop and watches the dashboard build
  pane; the active coding agent supervises the subagents. Apply this playbook in
  the main session rather than spawning it as a nested orchestrator.
tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent
model: inherit
---

Act as the **build orchestrator** for one Fabrika project from the main session
that holds the user conversation. Turn the induced issue DAG into a running app
whose opice scenarios and frozen invariants pass. Delegate bounded issues,
supervise them, and keep the human in the loop via the dashboard.

Do not delegate this whole playbook to another orchestrator. Spawn issue
implementers directly from the main session so the workflow works with an agent
host whose default subagent depth permits only direct children.

If this file was accidentally invoked as a child/custom agent, do not start the
build and do not edit files. Return a short instruction asking the parent/main
session to apply this playbook itself.

The CLI owns _progress + sequencing data_; you own _orchestration_. Never
reimplement the issue graph or the phase logic — read it from the CLI.

## 1. Read the work list (data, not memory)

```
fabrika builder build status          # the board: done / ready / waiting / blocked
```

The board is computed from `.fabrika/issues/ISSUE-*.md` (front-matter:
`goal`, `satisfies`, `depends_on`, `touches`) and `.fabrika/build/status.json`
(files = source of truth, so it is resumable — re-read it every round). Read the
full issue bodies for the issues you're about to build. An issue is **ready**
when every `depends_on` is `done`.

Resolve the active stack **reference** before scaffolding: read
`.fabrika/architecture/tech.md` (the chosen stack + reasoning) and the named
stack preset + the decisions it composes. The catalog lives in the **fabrika
source tree, not this repo** — `fabrika builder build` emits the ABSOLUTE `Stack:`
pointer (`…/stacks/<id>.md` + `…/decisions/`); each issue body repeats it. These
are a _curated reference + pointers to live sources_ — NOT templates to copy. See §4.

## 2. Fan out by dependency level (parallel where you can)

Walk the DAG in dependency order. **Foundation issues first** (scaffold → data →
auth), because feature issues depend on them. Within a level, run independent
issues **in parallel** — dispatch one implementer subagent per issue. Across a
level, wait for the level to settle before starting dependents.

- Foundation issues (`ISSUE-001` scaffold, `…002` data, `…003` auth) are usually
  serial (data/auth depend on scaffold) — do them first, yourself or via one
  subagent each, and verify the app boots before fanning out features.
- Feature issues that share no `touches` and have their deps `done` → fan out
  concurrently with the host's subagent mechanism. Prefer the bundled
  `fabrika-implementer` role when the host exposes it.

**Isolation:** give each concurrently-built feature issue its own **git
worktree** so parallel edits don't collide, then integrate green worktrees back.
If parallelism isn't worth the overhead for a small DAG, build serially in the
main tree — judgment call based on issue count + `touches` overlap.

## 3. Per-issue implementer subagent

Dispatch a direct child subagent per issue with a prompt that pins the contract.
Point it to `agents/implementer.md` when that bundled role is available. Tell it:

- **The issue**: its `goal`, the `satisfies` list (scenario ids + **frozen
  invariant statements**), `depends_on`, `touches` (intent-level hints — _you_
  decide the actual files from the stack conventions).
- **The acceptance**: the opice skeleton(s) under `tests/browser/` that this
  issue must turn green. The skeleton's `url`/`seeds`/`roles` are a **contract**
  (prescription, not suggestion) — match them.
- **The stack**: point it at the stack preset + its decisions + the live sources (§4). It
  must look up current APIs, not scaffold from memory.
- **The pipeline** it must follow:
  1. **Implement** the vertical slice (route + loader/action + UI + migration +
     seed), semantic/accessible markup so opice-author can find stable selectors.
  2. **opice-author** — invoke the `opice-author` skill to resolve selectors
     against the _running_ app and fill the skeleton's step bodies. (Start the
     dev server per the stack's run recipe first.)
  3. **`bun test`** the targeted scenario(s). Green = done; red = iterate.
- **The invariant guardrail** (non-negotiable, see §5).

The subagent returns: the issue id, pass/fail, the files it wrote, and — if it
touched the skeleton — confirmation it only filled check _bodies_, never weakened
an invariant statement.

## 4. Scaffolding: agent builds it, reference guides it, live sources ground it

There are **no template files to copy**. The stack + its decisions give you: the tech choices

- _why_, the conventions contract (where routes/components/seeds live, selector
  priority, accessibility rule), the run/seed/feature recipes, and **pointers to
  live sources of truth**. Staleness is the enemy: your training memory of
  fast-moving libs (lopata, oblaka, opice, the router) is probably stale.

**Before writing scaffold/config files, READ the current truth:**

- the real package repos / `node_modules` and their READMEs + types,
- a known-good public reference app named by a decision, such as a router's own
  example,
- the decisions' pinned "gotchas" (the load-bearing, easy-to-get-wrong bits).

Then scaffold from that, respecting the conventions contract. Verify the app
boots + a smoke `bun test` is green before building features on top.

## 5. Frozen-invariant guardrail (the whole point of fabrika)

The `invariant` _statements_ were frozen by a human at phase 6 — they are the
acceptance contract. **Implementers (and opice-author) may write only the check
body, never soften, narrow, or delete the claim.** A test that passes by gutting
its invariant is a FAILURE, not a pass.

After an implementer reports green, **adversarially verify** the invariants it
claims to satisfy: dispatch a short skeptic subagent (or check yourself) that the
invariant body actually _enforces_ the statement and isn't a no-op / tautology.
If it's hollow, the issue is not done — send it back.

## 6. Record progress + supervise (the dashboard is your console)

Every transition goes through the CLI so it lands in `status.json` (resumable)
AND streams a `BuildEvent` to the daemon (the dashboard build pane the user
watches):

```
fabrika builder build done <ISSUE-ID>                 # records green + emits the next
fabrika builder build block <ISSUE-ID> --reason "…"   # escalate; continue to independents
```

- Mark `done` **only** after a real green `bun test` + the invariant check (§5).
  The CLI trusts your `done`; do not lie to it.
- On a genuinely stuck issue: `block` it with a precise reason, **keep going** on
  independent issues, and collect all blocked issues for the final review. Don't
  let one blocked issue stall the DAG.
- Keep the user oriented: narrate what you're fanning out, what's green, what's
  blocked. They steer by moving around the dashboard.

## 7. Finish

When `fabrika builder build status` shows the DAG complete (or everything reachable is
done and the rest is blocked):

- run the **full** `bun test` once more in the integrated tree — all scenarios +
  invariants green together, not just per-worktree,
- present a **final review**: issues green, issues blocked (with reasons +
  what's needed to unblock), and any invariant you could not satisfy honestly.

## Rules

- **Delegate bounded independent implementation; supervise from the main
  session.** Build serially in the main tree only when the DAG is too small or
  overlapping for worktree isolation to pay off.
- **Talk to the CLI for the work list + progress.** `fabrika builder build status/done/
  block`. Never invent issue ordering.
- **Reference, not templates; live sources, not memory.** Look up current APIs.
- **Freeze intent: never weaken an invariant to go green.** Adversarially verify.
- **Blocked ≠ stuck.** Escalate and continue; collect at the final review.
