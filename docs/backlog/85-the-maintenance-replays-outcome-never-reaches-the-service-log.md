---
id: 85
title: The maintenance replay's outcome never reaches the service log
blocked-by: []
---

# 85 — The maintenance replay's outcome never reaches the service log

**Summary.** Control's five-minute maintenance runs as a Zerops `crontab` command in its own
process; the platform records that the command started (`USER zerops pid … cmd … crontab run`) but
collects nothing the command prints. Every `operations catalog sync: …` line the replay emits is
lost, so the one sync that repairs a stale lease (backlog 84) is the one an operator cannot see.
Effort S.

## Problem

On 2026-08-21 the registration's sync logged `coalesced revision 10` and the replay at the next
cron tick delivered the revision — proven only by the deploy that followed, because no
`operations catalog sync: applied revision 10` line exists anywhere in the control service's log.
The same applies to `run sweep`, the release replay and `maintenance failed` on stderr.

## Direction

Either route the replay's outcome through a channel the log collects — an HTTP call from the cron
command to the running service, which then logs — or record the outcome in the database and show it
in the console and `fabrika control` (the catalog state already carries `last_attempt_at`,
`last_success_at`, `last_error`; a `last_outcome` beside them would do). Record the platform fact
itself in `docs/reference/zerops-platform.md` as a row of the `platform-facts` table once a probe
can read it (it needs a deployed service with a crontab, so it belongs to the slow, opt-in cases).
