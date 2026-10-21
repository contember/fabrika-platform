# Installing fabrika on Zerops — the operator's guide

From an empty Zerops account to a serving application. This guide ships with the CLI, so it matches the
release you run. It gives the order and the traps. Each command's flags are in its own help, and that text
is authoritative:

```bash
fabrika platform --provider=zerops --help
fabrika control --help
```

Run the steps in order and check each one before the next. Every command refuses a missing value with a
message that names the flag or the variable to set. Read the message: it names the fix.

## Before you start

**Ask the human for these first.** You cannot produce them, and each one blocks a later step:

| What                                                                                  | Needed at  |
| ------------------------------------------------------------------------------------- | ---------- |
| A Zerops PERSONAL access token of a client OWNER, generated in the Zerops GUI         | step 1     |
| A verified Zerops account (credit topped up once); an unverified one owns ONE project | step 5     |
| A `gh` login allowed to create a repository in the organization that owns it          | step 3     |
| The administrator's e-mail address, and the human to open the enrollment URL          | step 2     |
| For a PRIVATE application repository: the GitHub App connected in the console         | step 5     |
| The fabrika release tag to install, for example `v0.4.3` (a branch is refused)        | steps 1, 3 |
| The four decisions below                                                              | steps 1, 5 |

Every namespace is a Zerops project of its own, so the first one fails with `clientProjectCountLimitExceededTopUp`
on an unverified account (observed 2026-10-15).

Also needed on the machine: [Bun](https://bun.sh) ≥ 1.3, `git`, `gh`, `curl` and `jq`.

## Decisions: ask the human, with the prices

Each choice trades price against stability, and two of them cannot be undone. Show the human this section
and let them choose; do not pick for them. Prices are Zerops' list prices as of 2026-10-15
([zerops.io/pricing](https://zerops.io/pricing)): a shared core $0.60, a dedicated core $6.00, RAM $3.00 per
GB, disk $0.10 per GB and object storage $0.01 per GB, each per 30 days and billed per minute. A Lightweight
project core is free (15 build hours, 100 GB egress); a Serious one is $10 (150 build hours, 3 TB egress, a
highly available balancer). The figures below are the idle FLOOR. Every service scales up under load, to 8
cores and 48 GB per container, and costs more while it does.

**1. Platform tier** (`platform install --tier`, step 1). Cannot be changed later: a project's core package
is upgrade-only, and the data services differ.

| Tier              | What runs                                                                                                                                                                           | Idle floor  | Fails when                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------ |
| `light` (default) | Lightweight core. Two single-node PostgreSQL (`oltp-hobby`): `db` for IAM and control, `operationsdb` for Operations; one shared bucket; one container each.                        | about $7.50 | any one container or `db` is down: sign-in stops |
| `standard`        | Serious core. HA PostgreSQL (3 nodes, `oltp-production`, dedicated CPU) for IAM and control; a second HA PostgreSQL and bucket for Operations; two containers of IAM and the proxy. | about $100  | survives the loss of one node of each            |

Most of `standard`'s price is the identity database's dedicated floor (about $72). `light` is right for an
evaluation and a small fleet that tolerates an outage; `standard` for sign-in that must stay up.

**What a lost node costs.** Zerops has no point-in-time recovery. Its backups are logical dumps of a whole
database service, daily between 00:00 and 01:00 UTC unless the service sets another schedule, and a restore is
manual (download, then `pg_restore`). A single-node PostgreSQL whose node fails loses everything written since
its last backup and stays down until someone restores it. An HA PostgreSQL (three nodes) keeps both its data and
its service. A deploy never takes a one-container runtime down, because Zerops starts the new container before
it stops the old one; how fast Zerops replaces one lost with its node is not measured. `platform install` and
every `platform deploy` set the platform database `db` (users, grants, deploy records) to back up hourly.
Operations' own `operationsdb` keeps the daily default: its error history does not need that schedule.

**Presets.** The choices below combine into three shapes. Prices are the idle floor for three applications in
one production namespace; an application with a database runs at a 0.5 GB floor, about $2.10 per container.

| Preset     | Platform tier | Production namespace                                                                                | Idle floor | A lost node costs                                                 |
| ---------- | ------------- | --------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| evaluation | `light`       | `cheap`, single-node PostgreSQL, one container each                                                 | about $16  | the data written since that database's last backup, and an outage |
| data       | `light`       | `cheap` with `--postgres-type=postgresql:ha@18 --postgres-profile=oltp-staging`, one container each | about $26  | applications' data survives; platform data since its last backup  |
| stable     | `standard`    | `cheap` HA as above, `--core-package=SERIOUS`, two containers of each application                   | $130+      | a short failover; the namespace proxy has one container           |

A staging namespace (`cheap`, single-node) adds about $8 to any of them.

**2. Namespace preset** (`control namespaces create --preset`, step 5). A namespace is the Zerops project
applications run in. Each one adds its own proxy, about $1.08. A `cheap` namespace's shared PostgreSQL is
single-node unless `--postgres-type=postgresql:ha@18` asks for HA (about $11 at `--postgres-profile=oltp-staging`);
the type is fixed once the namespace exists, the profile is not.

| Preset          | Where an application's database lives                                   | Use with                             |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------ |
| `cheap`         | One shared single-node PostgreSQL in the namespace, about $1.45 for all | `fabrika.cheap.config.ts`            |
| `mid` (default) | Each application imports its own database into the namespace            | `fabrika.config.ts`                  |
| `full`          | The namespace belongs to ONE application (`--exclusive-app=<id>`)       | an application that must be isolated |

**3. The application's database** (the application's `fabrika.config.ts`, before step 5). The example
declares `postgresql:single@18` at `oltp-hobby`, about $1.45, plus its runtime at about $2.10 per
container (a deploy raises the floor of an application with a database to 0.5 GB). `postgresql:ha@18` survives a node failure: about $11 at `oltp-staging` (shared CPU), about $72 at
`oltp-production` (dedicated). Single to HA later means a new service and a data migration.

**4. Namespace core package** (`--core-package=LIGHT|SERIOUS`, step 5). `LIGHT` is free and the default on
every environment. `SERIOUS` adds $10 per namespace and a highly available balancer in front of its proxy,
and it can never be downgraded again.

## Secrets: rules for an agent

- Every credential is read from the ENVIRONMENT ONLY. No command takes one as a flag.
- Never print a credential, never put one in a command line you echo, never commit one.
- `platform install` writes every credential it creates to `--secrets-file`, mode `0600`, before it places
  the first one. That file is the ONLY readable copy. Zerops stores them as sensitive variables and answers
  `REDACTED` when they are read back, so never try to read a secret from the Zerops API, and never ask the
  human for sudo mode to do it. Back the file up where the human keeps credentials.
- Load the file in a subshell, so its integration token never replaces the personal one in your shell:
  `( set -a && . <secrets file> && set +a && fabrika … )`.
- Keep any other credential in its own `0600` file (`umask 077` first) and pass it as `NAME="$(cat <file>)"`.
  Check a file with `wc -c`, never with `cat`.

## Step 0. Get the CLI at the release tag

`platform install` and `platform deploy` upload the source of the checkout the CLI runs from, and refuse
anything else (`--source-dir`). So the bring-up runs from a clean clone at the tag, not from a CLI installed
with `bun add --global`:

```bash
git clone --depth 1 --branch <tag> https://github.com/contember/fabrika-platform.git fabrika-platform
cd fabrika-platform && bun install --frozen-lockfile
```

In this guide, `fabrika` means `bun <clone>/packages/cli/src/index.ts`. Do not edit the clone: a dirty
checkout is refused, and a local commit is not on GitHub, so namespaces cannot fetch it.

Install a released tag, not a branch. Every application build fetches `@fabrika/check` at the version of the
checkout, so `install` and `deploy` refuse a checkout whose version npm does not have yet: `this checkout is
version X, which is not published yet`. A `main` between a release's version bump and its publish is such a
checkout.

## Step 1. Install the platform

```bash
export FABRIKA_ZEROPS_ACCESS_TOKEN="$(cat <personal token file>)"
curl -s -H "Authorization: Bearer $FABRIKA_ZEROPS_ACCESS_TOKEN" \
  https://api.app-prg1.zerops.io/api/rest/public/user/info | jq '{email, clients: [.clientUserList[] | {clientId, name: .client.accountName, role: .roleCode}]}'
fabrika platform install --provider=zerops --create-project --client-id=<clientId> --env=<name> --tier=<light|standard> \
  --secrets-file=<path outside the clone> --source-dir=. --yes > install.log 2>&1
```

- Check the token kind first. The `email` of a personal token is the person's address, and its `role` on the
  client is `OWNER`. An `email` of `token-<id>@zerops.io` is an INTEGRATION token. The install refuses one before
  it creates anything, because an integration token may not mint the token the control plane needs. Ask the
  human for a personal token instead.
- Run it from the clone root. It runs for many minutes: it imports the tier's services, builds the proxy
  once to learn the public hosts, then deploys everything.
- `--yes` is required when stdin is not a terminal.
- `--secrets-file` names a NEW file outside the clone, for example `~/fabrika-<env>.secrets.env`. An existing
  file is refused. The log prints no credential.
- The project id is printed BEFORE the long wait. If the run is interrupted, re-run with
  `--project-id=<id>` instead of `--create-project`.
- A project that already holds generated secrets is refused. Do not try to force it: a second bring-up
  over the same project would destroy the vault key. Start over in a new empty project.
- The account must be in the default region, or set `FABRIKA_ZEROPS_API_URL` for every command.
- Mail is optional. Without `--email-provider` the installation sends no mail. With one, add
  `--email-provider=<provider> --email-from=<address>`, optionally `--email-from-name=<name>`, and export the
  provider's variables from their own `0600` files. `fabrika platform install --provider=zerops --help` lists the
  providers and their variables, each named after its provider (for Resend `FABRIKA_EMAIL_RESEND_API_KEY`). They have no flag. The install writes the set on `iam` and `control`, the credentials sensitive. They
  are the human's own, so they are not copied into the secrets file.

**Check.** The log ends with the `Hand off` step: where the credentials are, `The console answers at
https://<console host>`, and an `ADMIT YOURSELF` box that holds the step 2 command with `--iam-host` filled
in. The secrets file exists with mode `0600`. The three hosts are printed earlier, right after pass 1, as
`✓ iam <host>`, `✓ console <host>` and `✓ operations <host>`. Write them down.

## Step 2. Admit the first administrator

```bash
( set -a && . <secrets file> && set +a && \
  fabrika platform admin --provider=zerops --email=<address> --iam-host=<IAM host from step 1> )
```

Without a mail provider it prints one enrollment URL and the time it expires. Nothing is e-mailed then, so
do not tell the human to wait for a message. The URL is a credential: give it to the human only, and do not
log it. The human opens it, sets a password and signs in at the console origin. With a mail provider, IAM
e-mails the enrollment instead, and the command reports the address and the expiry.

The URL is valid for ONE HOUR. Hand it over at once. A re-run creates nothing new: while the enrollment is
unused it only reports that one is outstanding, and it never prints the URL again. To get a new URL, after
expiry or after a lost one, run the same command with `--reissue`. It replaces the old enrollment, so the old
URL stops working.

## Step 3. Create the sidecar repository

The sidecar is a GitHub repository the operator owns. Its workflow runs `platform deploy` at the pinned tag.

The installation from step 1 already runs, and the sidecar is what upgrades it later (step 6). But `init`
triggers the workflow, and its run redeploys every platform service, control included. A deploy that is in
flight when control restarts fails, and its log names no reason. So run this step BEFORE step 5, and wait for
its run to end before the first `control deploy` (see the check below). Step 4 can run meanwhile.

`init` takes the integration token step 1 minted, never the personal one. The secrets file holds it as
`FABRIKA_ZEROPS_ACCESS_TOKEN`, beside the provisioning key. Run `init` from a directory that is NOT inside
any git repository. The fabrika clone is a repository, and a home directory under dotfiles version control is
one too. Otherwise pass `--checkout=<dir>` outside one:

```bash
( set -a && . <secrets file> && set +a && \
  fabrika platform init --provider=zerops <installation> --repo=<owner>/<name> --tag=<tag> \
  --project-id=<project id> --env=<name from step 1> --yes < /dev/null )
```

- Without `--repo` the repository is `contember/fabrika-zerops-<installation>`. Pass `--repo` for any
  other organization.
- Keep the local checkout path. `platform upgrade` needs it later (`--sidecar=<dir>`).
- `--tag` is written only into a NEW sidecar. An existing one keeps its `fabrika.ref`. When that pins another
  tag, `init` writes the GitHub Environment and then refuses to trigger the run, which would deploy the other
  tag. Its message names the fix: `fabrika platform upgrade --provider=zerops --to=<tag> --sidecar=<dir>`.

**Check.** The `platform` workflow run in the sidecar repository ends green. Wait for it before step 5:

```bash
gh run list --repo <owner>/<name> --workflow=platform.yml --limit=1   # its id, status and conclusion
gh run watch <run id> --repo <owner>/<name> --exit-status              # returns when the run ends; non-zero if it failed
```

## Step 4. Mint a machine key for `fabrika control`

```bash
( umask 077 && set -a && . <secrets file> && set +a && FABRIKA_IAM_RPC_URL=https://<IAM host> \
  fabrika control key issue --label=<name> --permissions=app.manage,namespace.manage,deploy.trigger,deploy.read \
  --expires-in=2592000 > control.key )
wc -c control.key && ls -l control.key
```

The secrets file supplies `FABRIKA_IAM_RPC_KEY` and `FABRIKA_IAM_PROVISIONING_KEY`.

- stdout carries the key and nothing else; the credential id goes to stderr. Keep the redirect inside the
  `umask 077` subshell: `control.key` is then created with mode `0600` (`-rw-------`). Outside it, the file
  is readable by other users.
- `FABRIKA_IAM_RPC_URL` is IAM's PUBLIC `https://` origin. The private `http://iam:3000` answers only inside
  the Zerops project.
- A key expires after at most 30 days. Mint a new one when it does.

For every `fabrika control` command from here on:

```bash
export FABRIKA_CONTROL_URL=https://<console host>
FABRIKA_CONTROL_KEY="$(cat control.key)" fabrika control apps list
```

**Check.** On a fresh installation `apps list` prints `no applications registered yet` (on stderr) and
exits 0. An authentication error means the key or the console origin is wrong.

## Step 5. Deploy the first application

The example is [`contember/fabrika-example-zerops`](https://github.com/contember/fabrika-example-zerops).
Its `fabrika.config.ts` places the app with its own database (`mid` preset), and `fabrika.cheap.config.ts`
places it on the namespace's shared PostgreSQL (`cheap` preset). Use the config that matches the preset.

**Repository access decides how you register** (step 5.2). Check it first:
`curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/<owner>/<name>`.

- `200`: the repository is public. Register it with `--installation-id=none`. Control reads it without a token,
  or with the organization's GitHub App once that App is connected and installed on the repository.
- `404`: GitHub hides it from an anonymous caller, so it is private (or the name is wrong). `register` refuses
  it with `--installation-id=none`. Ask the human to connect the GitHub App in the console first (Settings →
  Source, a browser flow), then register without `--installation-id`.

**Use the installation's release in the application.** The application's `@fabrika/*` packages, the CLI
among them, must be exactly the version of the tag you installed: for `v0.4.3`, `0.4.3`, not a range such as
`^0.4.3`, which resolves a later patch. Another version can build a manifest this installation's control
refuses or reads differently. The example's `main` pins the latest release; for an older installation, from
the fabrika clone of step 0, run `bun scripts/release.ts example-pin <application checkout> --tag=<tag>`. It
pins every `@fabrika/*` package exactly and commits nothing. Run `bun install` in the application repository,
then commit and push `package.json` and `bun.lock`. Check that every `@fabrika/*` package, the transitive ones
included, is the tag's version: `bun pm ls --all | grep @fabrika/`. Releases up to v0.4.6 name their own
`@fabrika/*` dependencies by a range, so a transitive one can still resolve a later patch of that line. Then
install the newest patch instead (step 6 upgrades an installation).

1. **Create a namespace** with the preset and core package the human chose (see Decisions). Without a
   custom domain bound to its proxy, pass `--public-access=zerops-subdomain`; the default is
   `custom-domain`, which serves no host until you bind one.

   ```bash
   fabrika control namespaces plan   --namespace=<id> --env=<name> --preset=<cheap|mid|full> --public-access=zerops-subdomain
   fabrika control namespaces create --namespace=<id> --env=<name> --preset=<cheap|mid|full> --public-access=zerops-subdomain
   fabrika control namespaces get    --namespace=<id>
   ```

   The namespace's Zerops project is `fabrika-<env>-<namespace id>`, beside the installation's
   `fabrika-<env>`. Pass `--project=<name>` for another name; it cannot change after `create`.

   `create` returns while the state is `pending`. Provisioning takes several minutes. Poll `get` every
   30 seconds until it is `ready`.

   - If the state is `failed`, `get` prints the cause and the command that resumes it on stderr. Run
     `fabrika control namespaces reconcile --namespace=<id>` and poll `get` again. Provisioning resumes from
     where it stopped. Do not create a second namespace.
   - `get` lists one host per line as `<host> <port> free` or `<host> <port> taken by <app>/<env>`. A
     `zerops-subdomain` namespace has six hosts, one per public port of its proxy: 8080 and 8082–8086. No
     port is special or reserved; 8081 is the proxy's health port and is never listed. Use ANY `free` host,
     for example the first one. Each host serves exactly one application environment, so six is the limit
     per namespace.

2. **Build and register**, from the application's repository root. The repository must be pushed: control
   deploys the commit on GitHub, not your working tree.

   `--app=<id>` is the application id the manifest carries: `jq -r .app.id fabrika.manifest.json` after the
   build. The application's `fabrika.config.ts` sets it (`defineApp({ id })`); the example takes it from its
   contract's vocabulary, and it is `notes`.

   ```bash
   bun install
   bunx fabrika app build --env=<name>                          # cheap: add --config=fabrika.cheap.config.ts
   FABRIKA_CONTROL_KEY="$(cat control.key)" bunx fabrika control register --provider=zerops --app=<id> \
     --repo=https://github.com/<owner>/<name> --env=<name> --manifest=fabrika.manifest.json \
     --namespace=<namespace id> --domain=<free host> --installation-id=none
   ```

   - `--installation-id=none` works only for a repository GitHub serves without a token. `register` reads it
     once and refuses one that is not publicly readable, so the failure shows here and not at deploy. A
     private repository needs the GitHub App connected in the console first (Settings → Source, a browser
     flow for the human); then omit the flag.
   - The public origin is where IAM returns a person after sign-in; without one, sign-in to the application
     fails with "… is not a registered return origin for this app". For a host the namespace lists, `register`
     sets `https://<free host>` itself and prints `public origin https://<host>` on stderr. For a custom domain
     the namespace cannot list, add `--public-origin=https://<domain>`.
   - `register` CREATES and refuses a second registration. A changed manifest goes through
     `control apps environments put` with the same placement flags. `put` derives no public origin.
   - Without `--trigger-ref` the environment deploys only on `control deploy`. With it, a push deploys it:
     `--trigger-ref=deploy/prod` is a branch, stored as `refs/heads/deploy/prod`. A tag needs the full form,
     `--trigger-ref=refs/tags/v1.2.0`, or a glob, `--trigger-ref='refs/tags/v*'` (quote it for the shell). A push
     reaches control only through the GitHub App's webhook; a public repository without the App is polled once a
     minute instead. Each environment of an app needs its own trigger ref.

3. **Deploy and follow it.**

   ```bash
   FABRIKA_CONTROL_KEY="$(cat control.key)" bunx fabrika control deploy --app=<id> --env=<name>
   FABRIKA_CONTROL_KEY="$(cat control.key)" bunx fabrika control runs list --app=<id>
   FABRIKA_CONTROL_KEY="$(cat control.key)" bunx fabrika control runs log --run=<run id>
   ```

   A failed run's log ends with `deploy failed: <reason>`. For example, `source resolve failed
   (ref_not_found)` means control could not read the repository or the ref. `GitHub rate limit for
   anonymous reads reached; resets at <time>` means GitHub refused control's tokenless reads: every tenant
   behind the cloud's egress address shares that limit. Deploy again after the reset, or connect the GitHub
   App in the console so reads of that organization's repositories carry a token. A namespace that hits the
   limit stays `provisioning` and retries on its own. A run that ends with
   `deploy interrupted: …; run the deploy again` lost Control mid-run, typically to step 3's workflow
   redeploying it: deploy again once Control is back.

   The deploy fails when the repository at the deployed commit does not match the registered manifest.
   Commit and push, rebuild the manifest, `apps environments put` it, and deploy again.

   On an environment named `prod`, a change that widens access waits for a person to approve it in the
   console before it deploys.

4. **Give the administrator a role in the application.** The step 2 grant administers the installation; it
   holds none of the application's actions, so the application answers `forbidden` to the administrator.
   No `fabrika` command grants an application role. The human does it in the console: Access → Users → the
   administrator → Add grant. Pick the application `<id>@<env>` (the example: `notes@<env>`), Named role / policy,
   a role the application declares (the example's `editor` reads, writes and deletes notes), the global scope,
   and Add grant. It takes effect at the next sign-in.

**Check.** The run ends `succeeded`. `https://<host>/healthz` answers 200, and `/` redirects to the IAM
sign-in. A green run proves only that Zerops accepted the build: have the human sign in and use the app.

## Step 6. Upgrade later

```bash
fabrika platform upgrade --provider=zerops --to=<newer tag> --sidecar=<sidecar checkout>
```

It commits the tag to the sidecar's `fabrika.ref`, pushes, and follows the workflow run it triggers. It
needs only the `gh` login. When the sidecar's `.github/workflows/platform.yml` differs from the one this CLI
generates, the same commit rewrites it, so run `upgrade` with the newest CLI: a hand edit of that file does not
survive. The workflow installs the Bun release the pinned tag names in its `.bun-version` (1.3.14 for a tag
that has none), never the newest one. From 0.4.2 or earlier, skip 0.4.3: its deploy stops at "Compose the proxy
manifest" because the proxy's `FABRIKA_PROXY_MANIFEST_JSON` is sensitive. Do not re-save that variable. Upgrade to a
later tag: its deploy deletes the variable, and needs no sudo mode. Existing namespaces keep their proxy version. To move one to the proxy of the
new release, after the run succeeded:

```bash
fabrika control namespaces update --namespace=<id> --proxy-source=current
```

It re-pins the namespace and queues the reconcile that rebuilds its proxy; poll `namespaces get` until it is
`ready`. Re-pin every namespace after each upgrade. Until then, Control refuses a deploy into it that uses a form
newer than 0.6 (a public procedure, a file output, a capabilities requirement, a forwarded webhook `Authorization`),
also when its proxy reads the form, and a proxy older than the replacement of the caller's `Authorization` keeps
forwarding a caller's `px_` key to the application (`docs/reference/deployment-namespaces.md`). A namespace pinned to a release before the proxy manifest moved into the build archive carries it in a
service variable, which Zerops caps at about 32 KB: when a deploy fails with `serviceEnvValueTooLarge`, this is
the fix, and it also accepts a namespace in `failed`.

## Set or rotate the mail transport

The installation's mail transport lives on the `iam` and `control` services. Zerops is its record (ADR-0004),
and Control hands a copy to every application whose job declares `mailer: 'installation'`. To add one to an
existing installation, change the provider, or rotate a key:

No `fabrika` command does this: `platform upgrade` and `platform deploy` write no `FABRIKA_EMAIL_*` and remove
none, and `install` cannot be re-run.

1. Set the same `FABRIKA_EMAIL_*` variables on BOTH `iam` and `control`, in the Zerops GUI or with `zcli`:
   `FABRIKA_EMAIL_PROVIDER`, `FABRIKA_EMAIL_FROM`, optionally `FABRIKA_EMAIL_FROM_NAME`, and the provider's
   variables. Mark the credentials sensitive. Delete the variables of a provider you leave.
2. Restart `iam` and `control`. Each reads the transport at boot. IAM refuses to start on an invalid one.
   Control starts, logs a line that names the invalid variables, and refuses every deploy that needs the transport
   until you fix them and restart it.
3. Redeploy every environment whose contract uses `installation` mail. An application gets the new transport
   only at its next deploy. Until then it sends with the old one, and a revoked key fails its mail with
   `provider_unauthorized`.

Without a transport, a contract whose job declares `mailer: 'installation'` still deploys. Its jobs see that mail is
not available and leave their messages queued. After step 3 the next run sends them.

## When something fails

- Every refusal names its flag or variable. Fix that one value and re-run. `init`, `admin`, `deploy` and
  `upgrade` are safe to re-run. `install` is not: see step 1.
- A failed install pass 2 is finished with `platform deploy`, with the credentials from the secrets file. The
  install prints the command.
- Lost the secrets file? Nothing in fabrika can recover it, and Zerops will not hand the values back. Start a
  new installation in a new project.
- A Zerops build or deploy failure: read the service log in the Zerops GUI or with
  `zcli service log -S <service id> --show-build-logs`.
- Do not work around a refusal by editing the clone or the generated sidecar. Report what failed, with the
  command and its message, to the people who maintain fabrika.
