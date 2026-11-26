# UX reviewer brief

You review the usability of a running operations console as an independent reviewer. You did not build it and you
have no access to how it was built: do not read the repository's source code, its git history or the builder's
notes. You may read only `packages/dashboard/ux/personas/*.md`, this brief and the task cards that `bun run ux tasks`
prints in `packages/dashboard` (persona, goal, success text, start route, budget). Do not open `ux/tasks/`,
`ux/pages/` or `ux/checks/`: they hold the reference paths and the expected placements you are meant to judge
yourself.

The round's assignment (base URL, browser session, tasks, pages, output path) is in the file you were given with this
brief. Write findings in English and quote UI labels exactly.

## Tools

Drive the console with the `agent-browser` CLI, always with `--session <your session>`, and run
`agent-browser --session <s> set viewport 1440 900` first. Opening the base URL signs you in; nothing is typed.

- Look at the page through `agent-browser --session <s> screenshot <path>` (the viewport, not `--full`). Scroll to
  see more.
- Use `agent-browser --session <s> snapshot -i` only to find the element you already decided to act on, never to
  read the page.
- After every action record the UI state: `agent-browser --session <s> eval "$(bun run --silent ux snippet)"`, run in
  `packages/dashboard`. A state is exactly what the snippet prints; scrolling is not a state.
- Do not change data beyond what a task asks for. Never delete anything. Close your session when you finish.

## Part A: persona walkthroughs

For each task in the assignment, become its persona (`personas/<persona>.md`) and follow its walkthrough rules.
Start at the task's start route. Before each action write what you expect; after it, what happened. Record every
hesitation and every step back. Stop when the task's success text holds, or give up after twice the task's
`budget.states` states (ten states when the card has no budget yet) and describe where you looked.

## Part B: element triage

For each page in the assignment, list every section heading, table column, tab, labelled region and action the page
shows on its default view. Leave out the console's shell (the navigation rail, the account menu, "Go to…"). For each
element give:

- `usedBy`: the assignment's tasks that read or operate it (reading counts);
- `consequence`: 2 = the person is blocked or misses a warning without it, 1 = slowed down, 0 = nothing happens;
- `placement`: `primary` (content column, above the fold), `secondary` (visible), `disclosed` (a tab, a collapsed
  section, a menu), `technical` (for an operations audience only), `remove`;
- `why`, one line.

An element with consequence 2 is never hidden. An element no task uses is a candidate, not a verdict: say what it
might be for.

## Part C: findings

A finding is a concrete usability problem with evidence. Each one:

- is tied to a task or to a persona expectation (quote it); one you cannot tie is taste: drop it;
- carries evidence: the screenshot path, the step number of Part A or the exact UI label;
- has a severity: `blocker` (a main task fails or a persona would get lost), `should` (slows down, confuses, wrong
  emphasis, raw or technical text on the main path, an inconsistent pattern), `note`;
- proposes a fix as a decision ("show only the rules that differ from the default"), not a patch.

Judge each page on its own merits; do not compare versions. Visual taste (colours, fonts, radii) is out of scope.
Report at most 15 findings per page, the most important first. A page without a real problem is a valid result.

## Output

Write one JSON file to the assignment's output path:

```json
{
	"reviewer": "<model name>",
	"tasks": [
		{
			"id": "t01-environment-state",
			"persona": "developer",
			"success": true,
			"gaveUp": false,
			"states": ["/apps", "/apps/notes | tab:Overview"],
			"steps": [
				{ "n": 1, "action": "…", "expected": "…", "outcome": "…", "state": "…" }
			],
			"hesitations": [{ "step": 2, "what": "…" }]
		}
	],
	"triage": [
		{
			"page": "application-overview",
			"element": "Recent runs",
			"kind": "section",
			"usedBy": [],
			"consequence": 0,
			"placement": "secondary",
			"why": "…"
		}
	],
	"findings": [
		{
			"id": "F1",
			"page": "application-overview",
			"severity": "should",
			"tiedTo": "developer: \"Deploy next to the environment it deploys\"",
			"title": "…",
			"evidence": { "screenshot": "…", "step": 3, "label": "Deploy" },
			"fix": "…"
		}
	]
}
```

Finish with a one-paragraph summary in your reply: the three most important findings and anything that made the
review unreliable (a crash, a sign-in problem, a task you could not start).
