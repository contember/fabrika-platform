# fabrika-platform ({{ACCOUNT}})

The **per-account root of trust** for the {{ACCOUNT}} Cloudflare account. Its GitHub pipeline deploys the
fabrika control-plane base so the control plane never deploys itself:

```
Stage 1 — IAM (root authz)
Stage 2 — fabrika runner + control plane
apps (poplach, revizor, …)              ← deployed through fabrika, not here
```

Generated and maintained by **`fabrika platform init --provider=cloudflare {{ACCOUNT}}`** (`@fabrika/cli`). Secrets and variables live in
the **`{{ACCOUNT}}` GitHub Environment** (Settings → Environments) and are written there by the CLI.

`contember/fabrika-platform` is public and pinned in [`fabrika.ref`](./fabrika.ref). The pipeline checks it
out once, builds and deploys IAM from `packages/iam-ui` and `packages/iam`, then runs
`fabrika platform deploy --provider=cloudflare` for `packages/runner-cloudflare` and
`packages/control`. The workflow is idempotent, so
re-running it is a safe redeploy.

## First bring-up

Run `fabrika platform init --provider=cloudflare {{ACCOUNT}}` from a laptop with the Cloudflare API token in hand. It creates this repo,
the GitHub App, the Environment with its secrets and variables, and triggers the workflow with
`build_runner_image=true`. The first run builds and pushes the runner container image into the account.

To close the escape hatch once IAM grants you admin, set the `{{ACCOUNT}}` Environment variable
`FABRIKA_CONTROL_BOOTSTRAP_ADMINS` to `[]` and re-run the workflow.

## Routine redeploy or version bump

- Bump [`fabrika.ref`](./fabrika.ref) to a new `contember/fabrika-platform` commit or tag and push.
- Or run _Actions → platform → Run workflow_ manually. `build_runner_image` stays false by default.

`fabrika.ref` is operator-owned. `fabrika platform init` creates it once and does not overwrite later version pins.
