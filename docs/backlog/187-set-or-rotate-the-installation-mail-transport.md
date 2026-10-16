---
id: 187
title: Set or rotate the installation's mail transport with one command
blocked-by: []
---

# 187 — Set or rotate the installation's mail transport with one command

**Summary.** Add `fabrika platform mail`: it sets or rotates the installation's mail transport on IAM and Control and
redeploys every application environment that sends through it. Small to medium; decided, not scheduled.

## Problem

The installation's mail transport ([ADR-0019](../decisions/0019-portable-outbound-email.md) §4) is written once, by the
installer: `platform install --email-provider` on Zerops writes the `FABRIKA_EMAIL_*` set on `iam` and `control`, and
`platform init` on Cloudflare writes it into the installation's GitHub Environment. Afterwards nothing changes it as
one step:

- **Zerops.** The operator sets the same variables on both services by hand, in the GUI or with `zcli`, marks the
  credentials sensitive, restarts both, and redeploys each environment whose contract declares
  `mailer: 'installation'` (`packages/provider-zerops/src/installation/guide.md`, "Set or rotate the mail transport").
  A value written to one service and not the other leaves IAM and the applications on different transports.
- **Applications.** Control hands the set at each deploy (`packages/control/src/mail-transport.ts`). An environment
  that is not redeployed keeps the old set, so a provider key that was revoked fails its mail with
  `provider_unauthorized` until someone deploys it.
- **Cloudflare.** Re-running `platform init` rewrites the values it is given and deletes none, so an old provider's
  variables, a display name or a tag stay in the Environment until the operator deletes them.

## Approach / acceptance

1. `fabrika platform mail --provider=<cloud> --email-provider=<name> --email-from=<address> [--email-from-name=…]`
   reads the provider's variables from the environment only, through `readInstallationEmail`
   (`packages/installation-init/src/email.ts`), as the installers do. `--email-provider=none` removes the transport.
2. **Zerops:** it writes the set on `iam` and `control` (credentials sensitive), deletes the `FABRIKA_EMAIL_*` names
   the new set does not hold, restarts both, and enqueues a deploy for every environment whose approved contract
   `installationMailJobs` names. It prints the environments it redeployed, never a value.
3. **Cloudflare:** it writes the Environment, deletes the old provider's names, and triggers the workflow. Control
   there holds no transport, so there is nothing to redeploy.
4. Removing the transport while an approved contract still declares `installation` mail names the environments that
   will run without mail (their jobs leave their mail queued) and asks the operator to confirm.
5. `--check` validates the set without writing it, so an operator can test a value before a restart: Control keeps
   running on an invalid transport but refuses every deploy that needs it.

Witness: an install test with the emulated Zerops API sees the set on both services, a stale provider variable
deleted, and one deploy enqueued per environment that declares `mailer: 'installation'`; a run with `none` while such
an environment exists asks for confirmation and then redeploys it with `FABRIKA_EMAIL_PROVIDER=none`.

## Touch points

`packages/provider-zerops/src/installation/` (a `mail` command, `guide.md`), `packages/provider-cloudflare/src/installation/`,
`packages/installation-init/src/email.ts`, `packages/control/src/mail-transport.ts` (or a Control API that lists the
environments to redeploy), `docs/reference/outbound-email.md`.

<!-- Origin: the application-mail work (ADR-0019 §4; the installer writes the transport, and nothing fans a change out). -->
