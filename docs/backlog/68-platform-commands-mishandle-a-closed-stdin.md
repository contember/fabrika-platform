---
id: 68
title: Platform commands mishandle a closed stdin, in opposite directions
blocked-by: []
---

# 68 — Platform commands mishandle a closed stdin, in opposite directions

**Summary.** `platform install` runs unattended when it should refuse, and `platform init` cannot be run
unattended at all. Both were found by running them; neither is visible from a test. Effort S.

## Problem

The two commands that mutate a cloud account handle a non-interactive stdin in exactly the wrong ways.

- **`install` proceeds.** Every confirmation defaults to yes and an empty answer is indistinguishable
  from EOF, so with stdin closed the command walks its whole sequence — six generated secrets, an
  import, two deploy passes — without a human ever answering. The prompts read as a guard against
  someone typing `n`, not as a guard against nobody being there.
- **`init` hangs.** Each prompt opens its own readline and closes it, and closing a readline over a
  piped stdin discards whatever is already buffered — so the second answer and everything after it is
  swallowed and the command stops on question 2. Driving it on 2026-08-10 needed a PTY.

`init` is the command an operator is most likely to script, and `install` is the one that must not be.

## Approach / acceptance

Decide the intent per command and make stdin agree with it:

- a command that must be confirmed detects a non-interactive stdin and refuses, naming the flag that
  says "yes, unattended" (which is then an explicit, auditable choice);
- a command meant to be scriptable reads its answers from one reader, or from flags, so a pipe drives it
  the way a terminal does.

Acceptance: `printf '…' | fabrika platform init --provider=zerops …` completes without a PTY, and
`fabrika platform install --provider=zerops < /dev/null` stops before it writes anything.

## Touch points

`packages/installation-init/`, `packages/installation-zerops/src/install.ts`, `packages/cli/`.

<!-- Origin: sprint-2026-08-07-zerops-from-scratch-install, WU3 and WU5 run logs (finding A). -->
