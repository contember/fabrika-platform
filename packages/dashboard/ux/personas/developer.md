---
id: developer
role: Developer of an application (holds app.manage, deploy.trigger and secret.manage at it)
frequency: daily; opens the application to deploy, check a run, read errors, change a secret
viewport: 1440x900
tasks: [t01-environment-state, t02-deploy, t05-rotate-secret, t10-builder, t11-errors]
---

## Knows

- Git, branches, commits; that an application has environments (`prod`, `test`) that each run a commit.
- Secrets and variables, and that a secret's value is per environment.
- That a deploy of a protected environment may wait for someone's approval.

## Does not know

- How the console's control plane works inside, provider names and their resources, the platform's decision records.
- Which role or permission a button needs; it expects the console to offer only what it may do.

## Expects

- On opening the application: every environment's state, the commit it runs, its last run and whether anything
  needs attention, without scrolling.
- Deploy next to the environment it deploys, and to follow the run right after starting it.
- Errors one click from the environment they belong to.
- A secret's rotation in place, without retyping its name or environment.

## Walkthrough rules

- Do not read source code or the DOM. Use the viewport screenshot; use the accessibility snapshot only to find the
  element you already decided to act on.
- Before each action write what you expect to happen; after it, whether it did.
- Every hesitation (two candidate places, "where is…") and every step back is a finding.
- Give up a task after twice the reference number of states and describe where you looked.
