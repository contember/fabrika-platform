# Console UX review

The console's usability is checked in two layers: **scripts measure what can be measured; a model judges only what
cannot, and every claim carries evidence.** The reviewer is a separate agent that never sees the builder's
conversation or the source code, and judges each page on its own merits, never "is v2 better than v1". Persona
walkthroughs are synthetic: they find candidates that an exact check or a person then confirms.

## Files

| Path               | What it holds                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `personas/<id>.md` | Who the persona is, what they know and do not know, what they expect, how they walk through a task                                                            |
| `tasks/<id>.ts`    | One task: persona, goal, success text, start route, budget, and the reference path as code. Reviewers read the cards from `bun run ux tasks`, never the files |
| `pages/*.ts`       | The element map: each element, the tasks that use it, its consequence and its placement                                                                       |
| `checks/`          | The exact layer: the design-system adapter, the counting actor, the page checks and the CLI                                                                   |
| `review/brief.md`  | The reviewer's brief                                                                                                                                          |
| `patterns.md`      | The console's editing and layout patterns a new screen follows                                                                                                |
| `env.md`           | How to get a comparable environment: the local stack, its seed, the viewport                                                                                  |
| `calibration/`     | The reviewer's calibration set: canary and clean pages                                                                                                        |
| `baseline.json`    | The accepted reference paths, with the revision and viewport they were measured at                                                                            |
| `runs/`            | Run output (reports, screenshots, reviewer JSON); not committed                                                                                               |

Personas, tasks and the element map are the contract a page is judged against. A person approves them once; a round
does not add criteria. A task's budget is null until the first run measures its reference path; that measurement,
recorded in the task, is the budget from then on.

## Exact layer

```sh
bun run local:up && bun run local:smoke && bun run local:seed   # env.md
cd packages/dashboard
bun run ux [--only=<ids>] [--out=<dir>] [--writes] [--update-baseline]
bun run ux tasks       # the task cards a reviewer reads: no reference path
bun run ux snippet     # the state-key snippet for agent-browser eval
```

The run exits 1 when a gate fails. It refuses a `--base` that is not a local origin (default
`http://control.fabrika.localhost:18080`). Tasks marked `mutates` write data and run only with `--writes`.
`--update-baseline` records only paths within their budget.

| Check                                                             | Measured by                                                                                                                | Threshold                        | Kind     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------- |
| Every task succeeds                                               | the task's reference path and success check                                                                                | 100 %                            | gate     |
| Task budget                                                       | clicks, fills, key presses, states counted by `Actor`                                                                      | ≤ `budget` and ≤ baseline + 20 % | gate     |
| Element inventory                                                 | `pages/*.ts`: a `technical` or `remove` element visible on the default view, a `primary` element missing or below the fold | 0                                | gate     |
| Filled buttons per area                                           | each area (the page, a dialog) holds at most one `button.primary`; measured on the default view                            | ≤ 1                              | gate     |
| Accessibility                                                     | `@axe-core/playwright`, WCAG 2.1 A/AA, default view                                                                        | 0 serious or critical            | gate     |
| KLM time                                                          | modelled from the counted actions (Kieras)                                                                                 | trend                            | advisory |
| Text and interactive elements above the fold, screens, lead facts | `measureLayout`                                                                                                            | trend                            | advisory |
| Technical-looking text                                            | regex (UUID, long hex, `snake_case`, JSON)                                                                                 | candidates for the map           | advisory |
| Map elements not on the default view                              | labels without a match: hidden as approved, or renamed and the map is stale                                                | review the map                   | advisory |

**State.** The route with its query, the selected tab and the open dialog, as `stateKey` in `checks/actor.ts`
prints it. Scrolling is not a state. **Counting.** A click is every `click`, `check` or changed `select`; a fill is
one field, whatever its length; a key press is a `press` outside typing. The reference path is the shortest known
path, not a proven optimum.

Every task runs as the local administrator. Not built yet: runs under a narrower permission set (a data reader, a
manager of one application), the visible-field budget for forms, the keyboard walk, the page checks with a dialog open.

## Element triage

For each element: `usedBy` (tasks that read or operate it), `consequence` (2 = blocks or hides a warning, 1 = slows
down, 0 = nothing), `audience` and `placement`.

| Condition                      | Placement                                                  |
| ------------------------------ | ---------------------------------------------------------- |
| Every main task uses it        | `primary`: content column, above the fold                  |
| Some main task uses it         | `secondary`: visible                                       |
| Only secondary tasks use it    | `disclosed`: a tab, a collapsed section, a menu            |
| No task uses it, consequence 0 | `technical` for an operations audience, otherwise `remove` |
| Consequence 2                  | always visible, whatever the use                           |

An element no task uses is a candidate, not a verdict: removing one needs a person's approval.

## A round

1. Exact checks on a freshly seeded stack.
2. Two reviewers on the same stack (its ports are fixed, `env.md`), each in its own browser session, with
   `review/brief.md` and an assignment file: a Claude agent and a GPT agent. The assignment names the base URL, the browser session, the
   tasks, the pages (with one canary and one clean page from `calibration/`, unlabelled) and the output path.
   Reviewers get each task as a card, never the task files; `t08-grant-self` is left out, because its grant stays.
3. The builder merges the findings: drops those without evidence or without a task or persona they are tied to,
   merges duplicates and sets a severity:
   - `blocker`: a gate fails, or a persona fails a main task;
   - `should`: an advisory metric off its threshold, a hesitation, a rarely used element above the fold, a broken
     pattern;
   - `note`: the rest.
     A finding that needs a rule nobody has decided goes to a person as a decision.
4. The builder (never a reviewer) fixes every blocker and at most five other findings, reruns the exact checks,
   reverts a fix that breaks a gate and commits. The commit is the round's checkpoint.

**Canary.** A reviewer that misses the canary's known defects or reports defects on the clean page repeats the round
once; a second miss stops the loop as a reviewer problem.

**Stop.** _Done_: every gate passes and no blocker is left. _Exhausted_: three rounds, or a round without progress
(fewer blockers, fewer failed persona tasks, a better gate), with blockers left; it goes to a person as incomplete.
The best checkpoint has the fewest blockers, then the fewest `should`, then the lowest total budget; on a tie the
later one.

**For the person.** Before and after screenshots of the main tasks, the metrics table, the dropped findings with the
reason, the decisions to make, and for an exhausted loop the remaining blockers. Taste and visual hierarchy are
theirs to judge.
