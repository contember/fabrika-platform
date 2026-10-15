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

| What                                                                           | Needed at  |
| ------------------------------------------------------------------------------ | ---------- |
| A Zerops personal access token, generated in the Zerops GUI                    | step 1     |
| A `gh` login allowed to create a repository in the organization that owns it   | step 3     |
| The administrator's e-mail, and the human to open the enrollment URL           | step 2     |
| For a PRIVATE application repository: the GitHub App connected in the console  | step 5     |
| The fabrika release tag to install, for example `v0.4.2` (a branch is refused) | steps 1, 3 |

Also needed on the machine: [Bun](https://bun.sh) ≥ 1.3, `git`, `gh`, `curl` and `jq`.

## Secrets: rules for an agent

- Every credential is read from the ENVIRONMENT ONLY. No command takes one as a flag.
- Never print a credential, never put one in a command line you echo, never commit one.
- Keep each one in its own file with mode `0600` (`umask 077` first) and pass it as
  `NAME="$(cat <file>)" fabrika …`. Check a file with `wc -c`, never with `cat`.
- The provisioning key from step 1 is printed ONCE. Capture it from the output into its file at once.
  The only other copies are in the `iam` and `control` service environments.

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

## Step 1. Install the platform

```bash
export FABRIKA_ZEROPS_ACCESS_TOKEN="$(cat <personal token file>)"
curl -s -H "Authorization: Bearer $FABRIKA_ZEROPS_ACCESS_TOKEN" \
  https://api.app-prg1.zerops.io/api/rest/public/user/info | jq '.clientUserList[] | {clientId, name: .client.accountName}'
fabrika platform install --provider=zerops --create-project --client-id=<clientId> --env=<name> --source-dir=. --yes > install.log 2>&1
```

- Run it from the clone root. It runs for many minutes: it imports six services, builds the proxy once to
  learn the public hosts, then deploys everything.
- `--yes` is required when stdin is not a terminal.
- Capture the key right away and keep the log away from anything that publishes it:
  `grep -o 'FABRIKA_IAM_PROVISIONING_KEY=px_[A-Za-z0-9_-]*' install.log | cut -d= -f2 > provisioning.key`
- The project id is printed BEFORE the long wait. If the run is interrupted, re-run with
  `--project-id=<id>` instead of `--create-project`.
- A project that already holds generated secrets is refused. Do not try to force it: a second bring-up
  over the same project would destroy the vault key. Start over in a new empty project.
- The account must be in the default region, or set `FABRIKA_ZEROPS_API_URL` for every command.

**Check.** The log ends with `✓ iam <host>`, the console origin and the provisioning key box. Write down
the three hosts: IAM, console and Operations.

## Step 2. Admit the first administrator

```bash
FABRIKA_IAM_PROVISIONING_KEY="$(cat provisioning.key)" \
  fabrika platform admin --provider=zerops --email=<address> --iam-host=<IAM host from step 1>
```

It prints one enrollment URL. The URL is a credential: give it to the human only, and do not log it. The
human opens it, sets a password and signs in at the console origin. A re-run creates nothing new;
`--reissue` replaces an enrollment that expired unopened.

## Step 3. Create the sidecar repository

The sidecar is a GitHub repository the operator owns. Its workflow runs `platform deploy` at the pinned tag.

Read the integration token that step 1 minted. Never use the personal token here:

```bash
A=https://api.app-prg1.zerops.io/api/rest/public
H="Authorization: Bearer $FABRIKA_ZEROPS_ACCESS_TOKEN"
control=$(curl -s -H "$H" "$A/project/<project id>/service-stack?limit=100&offset=0" | jq -r '.list[] | select(.name=="control") | .id')
curl -s -H "$H" "$A/service-stack/$control/env" | jq -r '.items[] | select(.key=="FABRIKA_ZEROPS_ACCESS_TOKEN") | .content' > integration.token
```

Then run `init` from a directory that is NOT inside any git repository. The fabrika clone is a repository,
and a home directory under dotfiles version control is one too. Otherwise pass `--checkout=<dir>` outside one:

```bash
FABRIKA_ZEROPS_ACCESS_TOKEN="$(cat integration.token)" FABRIKA_IAM_PROVISIONING_KEY="$(cat provisioning.key)" \
  fabrika platform init --provider=zerops <installation> --repo=<owner>/<name> --tag=<tag> \
  --project-id=<project id> --env=<name from step 1> --yes < /dev/null
```

- Without `--repo` the repository is `contember/fabrika-zerops-<installation>`. Pass `--repo` for any
  other organization.
- Keep the local checkout path. `platform upgrade` needs it later (`--sidecar=<dir>`).

**Check.** The `platform` workflow run in the sidecar repository ends green:
`gh run list --repo <owner>/<name>`.

## Step 4. Mint a machine key for `fabrika control`

```bash
iam=$(curl -s -H "$H" "$A/project/<project id>/service-stack?limit=100&offset=0" | jq -r '.list[] | select(.name=="iam") | .id')
curl -s -H "$H" "$A/service-stack/$iam/env" | jq -r '.items[] | select(.key=="FABRIKA_IAM_RPC_KEY") | .content' > iam-rpc.key
FABRIKA_IAM_RPC_URL=https://<IAM host> FABRIKA_IAM_RPC_KEY="$(cat iam-rpc.key)" FABRIKA_IAM_PROVISIONING_KEY="$(cat provisioning.key)" \
  fabrika control key issue --label=<name> --permissions=app.manage,namespace.manage,deploy.trigger,deploy.read \
  --expires-in=2592000 > control-key.out
grep -o 'px_[A-Za-z0-9_-]*' control-key.out | head -1 > control.key && rm control-key.out
```

- `FABRIKA_IAM_RPC_URL` is IAM's PUBLIC `https://` origin. The private `http://iam:3000` answers only inside
  the Zerops project.
- A key expires after at most 30 days. Mint a new one when it does.

For every `fabrika control` command from here on:

```bash
export FABRIKA_CONTROL_URL=https://<console host>
FABRIKA_CONTROL_KEY="$(cat control.key)" fabrika control apps list
```

**Check.** `apps list` answers, with an empty list on a fresh installation.

## Step 5. Deploy the first application

The public example is [`contember/fabrika-example-zerops`](https://github.com/contember/fabrika-example-zerops).
Its `fabrika.config.ts` places the app with its own database (`mid` preset), and `fabrika.cheap.config.ts`
places it on the namespace's shared PostgreSQL (`cheap` preset). Use the config that matches the preset.

1. **Create a namespace.** It is the Zerops project applications are placed in. Without a custom domain
   bound to its proxy, pass `--public-access=zerops-subdomain`; the default is `custom-domain`, which serves
   no host until you bind one.

   ```bash
   fabrika control namespaces plan   --namespace=<id> --env=<name> --preset=mid --public-access=zerops-subdomain
   fabrika control namespaces create --namespace=<id> --env=<name> --preset=mid --public-access=zerops-subdomain
   fabrika control namespaces get    --namespace=<id>
   ```

   `create` returns while the state is `pending`. Provisioning takes several minutes. Poll `get` every
   30 seconds until it is `ready`, then pick a host it lists as `free`.

2. **Build and register**, from the application's repository root. The repository must be pushed: control
   deploys the commit on GitHub, not your working tree.

   ```bash
   bun install
   bunx fabrika app build --env=<name>                          # cheap: add --config=fabrika.cheap.config.ts
   FABRIKA_CONTROL_KEY="$(cat control.key)" bunx fabrika control register --provider=zerops --app=<id> \
     --repo=https://github.com/<owner>/<name> --env=<name> --manifest=fabrika.manifest.json \
     --namespace=<namespace id> --domain=<free host> --installation-id=none
   ```

   - `--installation-id=none` is for a PUBLIC repository. A private one needs the GitHub App connected in
     the console (Settings → Source, a browser flow for the human); then omit the flag.
   - `register` CREATES and refuses a second registration. A changed manifest goes through
     `control apps environments put` with the same placement flags.

3. **Deploy and follow it.**

   ```bash
   FABRIKA_CONTROL_KEY="$(cat control.key)" bunx fabrika control deploy --app=<id> --env=<name>
   FABRIKA_CONTROL_KEY="$(cat control.key)" bunx fabrika control runs list --app=<id>
   FABRIKA_CONTROL_KEY="$(cat control.key)" bunx fabrika control runs log --run=<run id>
   ```

   The deploy fails when the repository at the deployed commit does not match the registered manifest.
   Commit and push, rebuild the manifest, `apps environments put` it, and deploy again.

   On an environment named `prod`, a change that widens access waits for a person to approve it in the
   console before it deploys.

**Check.** The run ends `succeeded`. `https://<host>/healthz` answers 200, and `/` redirects to the IAM
sign-in. A green run proves only that Zerops accepted the build: have the human sign in and use the app.

## Step 6. Upgrade later

```bash
fabrika platform upgrade --provider=zerops --to=<newer tag> --sidecar=<sidecar checkout>
```

It commits the tag to the sidecar's `fabrika.ref`, pushes, and follows the workflow run it triggers. It
needs only the `gh` login. Existing namespaces keep their proxy version.

## When something fails

- Every refusal names its flag or variable. Fix that one value and re-run. `init`, `admin`, `deploy` and
  `upgrade` are safe to re-run. `install` is not: see step 1.
- A Zerops build or deploy failure: read the service log in the Zerops GUI or with
  `zcli service log -S <service id> --show-build-logs`.
- Do not work around a refusal by editing the clone or the generated sidecar. Report what failed, with the
  command and its message, to the people who maintain fabrika.
