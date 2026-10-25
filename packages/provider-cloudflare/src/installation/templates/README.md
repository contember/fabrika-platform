# fabrika-platform ({{ACCOUNT}})

The **per-account root of trust** for the {{ACCOUNT}} Cloudflare account. Its GitHub pipeline deploys the
fabrika control-plane base so the control plane never deploys itself:

```
Stage 1 — IAM (root authz)
Stage 2 — Operations
Stage 3 — fabrika runner + control plane
apps (poplach, revizor, …)              ← deployed through fabrika, not here
```

Generated and maintained by **`fabrika platform init --provider=cloudflare {{ACCOUNT}}`** (`@fabrika/cli`). Secrets and variables live in
the **`{{ACCOUNT}}` GitHub Environment** (Settings → Environments) and are written there by the CLI.
Scaffold commits use `[skip ci]`; init explicitly dispatches the workflow only after that Environment is configured.

Every credential this installation has is in that Environment — the Cloudflare API token, the vault KEK,
IAM's signing key, the provisioning key and `FABRIKA_RUNNER_KEY` (the shared key the
control plane presents to the deploy runner; Stage 3 pushes it to both Workers). Init therefore protects
`main` (no force pushes, no deletions) on a repository it creates, and restricts the Environment to
protected branches. The two go together: the Environment policy admits any branch that carries no
protection rule, so it is worth nothing on its own. GitHub Free offers neither on a private repository —
if init warned that one was refused, run the command it printed once the plan allows it.

Whatever the plan, add yourself as a **required reviewer** on the `{{ACCOUNT}}` Environment
(Settings → Environments → {{ACCOUNT}} → Required reviewers). It is the only rule that stops a push to
`main` from spending these credentials without a human first agreeing to it. Init deliberately does not
set it: it turns every deploy into an approval click, which is the operator's call and not the CLI's.

`contember/fabrika-platform` is public and pinned in [`fabrika.ref`](./fabrika.ref). The pipeline checks it
out once, then runs `fabrika platform deploy --provider=cloudflare` three times: `--component-config` for
IAM, `--component-config` for Operations, and the `--runner-config`/`--worker-config` pair for
`packages/runner-cloudflare` and `packages/control`. Every stage is a PLATFORM deploy because each names a
platform resource; `fabrika app deploy` is for applications and is refused one. The workflow builds the runner image from that same checkout into this account's
registry. It never depends on an image published by upstream CI or another account. Re-running it is
a safe redeploy.

## First bring-up

Run init with the Cloudflare API token in `CLOUDFLARE_API_TOKEN`:

```sh
fabrika platform init --provider=cloudflare {{ACCOUNT}} \
  --console-host=<host> --operations-host=<host> --iam-host=<host> \
  --auth-methods=<oidc|password|oidc,password> --email-provider=<none|{{EMAIL_PROVIDER_NAMES}}>
```

`fabrika platform init --provider=cloudflare --help` lists the optional flags. It creates this repo,
the Environment with its secrets and variables, and triggers the workflow. The run builds and pushes the
runner container image into the account.

Public repositories deploy without a GitHub App. To deploy private repositories, connect GitHub from the
control plane at **Settings → Source**: each connection is an organization-owned GitHub App whose key
Control keeps in its encrypted vault, never in this Environment.

To close the escape hatch once IAM grants you admin, set the `{{ACCOUNT}}` Environment variable
`FABRIKA_CONTROL_BOOTSTRAP_ADMINS` to `[]` and re-run the workflow.

IAM authentication methods are independent Environment switches: `FABRIKA_IAM_OIDC_ENABLED` and
`FABRIKA_IAM_PASSWORD_ENABLED`. At least one must be `true`. Password enrollment is managed through
IAM provisioning and its admin surface. Email delivery is optional; `FABRIKA_EMAIL_PROVIDER=none`
keeps password enrollment and reset admin-driven. A provider also needs the sender variable
`FABRIKA_EMAIL_FROM` (optionally `FABRIKA_EMAIL_FROM_NAME`) and its own Environment secrets and variables:

{{EMAIL_PROVIDER_VARIABLES}}

The workflow hands the same set to IAM and to the control plane. The control plane hands it to every application
whose job declares `mailer: 'installation'`, at that application's deploy.

To change or rotate them, re-run `fabrika platform init` with the new values; it rewrites this Environment
and triggers the workflow, which redeploys IAM and the control plane. An application gets the new set at its next
deploy: redeploy each environment that sends installation mail with
`fabrika control deploy --app=<id> --env=<name>`, or **Deploy** in the console.

Switching provider leaves the old provider's values stored: init writes the new ones and deletes none. IAM and
the control plane read only the selected provider's variables, but delete the old credentials so nothing holds them, for
example after leaving SmartEmailing:

```sh
gh secret delete FABRIKA_EMAIL_SMARTEMAILING_USERNAME --env {{ACCOUNT}}
gh secret delete FABRIKA_EMAIL_SMARTEMAILING_API_KEY --env {{ACCOUNT}}
gh variable delete FABRIKA_EMAIL_SMARTEMAILING_TAG --env {{ACCOUNT}}
```

Remove the same names from the installer env file (init prints its path when it starts), or a later run of
init resumes them.
IAM's and the control plane's Workers also keep the old provider's credentials as Worker secrets, which neither reads.
Delete each of them from both Workers, with the account's id in `CLOUDFLARE_ACCOUNT_ID` and its API token in
`CLOUDFLARE_API_TOKEN`:

```sh
for worker in prod-propustka-worker prod-vozka; do
  bunx wrangler secret delete FABRIKA_EMAIL_SMARTEMAILING_USERNAME --name "$worker"
  bunx wrangler secret delete FABRIKA_EMAIL_SMARTEMAILING_API_KEY --name "$worker"
done
```

## Routine redeploy or version bump

- Bump [`fabrika.ref`](./fabrika.ref) to a new `contember/fabrika-platform` commit or tag and push.
- Or run _Actions → platform → Run workflow_ manually.

Both paths rebuild the account-owned runner image from the exact checkout selected by `fabrika.ref`.

`fabrika.ref` is operator-owned. `fabrika platform init` creates it once and does not overwrite later version pins.
A bump does not rewrite this workflow. Re-run `fabrika platform init --provider=cloudflare {{ACCOUNT}}` with the same
flags, with the CLI of the release `fabrika.ref` names, to bring `.github/workflows/platform.yml` to the one that release
generates. A change in what the workflow hands a stage (such as the mail transport the control plane holds) reaches
the account only this way.
