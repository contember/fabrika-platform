# Installing fabrika on Zerops

The operator's procedure from an empty Zerops account to a serving application. It gives the order,
the prerequisites, and how to check each step. It does not repeat the flags: every command prints its
full surface, and that text is authoritative.

```bash
fabrika platform --provider=zerops --help
fabrika control --help
```

The reasons behind the shape of this procedure are in
[ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) (the operator
owns the pipeline) and [ADR-0027](../decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)
(one `deploy` step owns the order).

## Overview

| Step | Command                                                                          | Runs        | Result                                                     |
| ---- | -------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------- |
| 1    | `fabrika platform install`                                                       | once        | A running installation, and the provisioning key           |
| 2    | `fabrika platform admin`                                                         | once        | The first administrator's enrollment URL                   |
| 3    | `fabrika platform init`                                                          | re-runnable | The sidecar repository whose pipeline deploys the platform |
| 4    | `fabrika control key issue`                                                      | per client  | A machine key for `fabrika control`                        |
| 5    | `fabrika namespace create`, `fabrika control register`, `fabrika control deploy` | per app     | A serving application                                      |
| 6    | `fabrika platform upgrade`                                                       | per release | The installation on a newer fabrika tag                    |

Steps 1–3 run on the operator's machine. `install` creates an installation; `init` and `deploy` refuse
to. Step 2 needs only step 1, so it may run before or after step 3.

## Prerequisites

- **[Bun](https://bun.sh) ≥ 1.3.** The CLI is TypeScript and runs on Bun.
- **The `fabrika` command.** `bun add --global @fabrika/cli`, then `fabrika --help`.
- **`git` and the [GitHub CLI](https://cli.github.com) (`gh`), signed in** with permission to create a
  repository and write Environment secrets in the organization that will own the sidecar. `init` and
  `upgrade` use the operator's own `gh` login and hold no GitHub credential themselves.
- **A Zerops personal access token**, generated in the Zerops GUI. Only `install` uses it. The
  installation never stores it: `install` mints a separate integration token (client role `NO_ACCESS`,
  `ADMIN` on the one project) for the control plane.
- **The Zerops client id.** It is the client named in the `clientUserList` entry of `GET /user/info`:

  ```bash
  curl -s -H "Authorization: Bearer $FABRIKA_ZEROPS_ACCESS_TOKEN" \
    https://api.app-prg1.zerops.io/api/rest/public/user/info
  ```

  Set `FABRIKA_ZEROPS_API_URL` for every command when the account is not on the default region.
- **A published fabrika tag** to pin, for example `v0.2.0`. A branch is refused.

Credentials are read from the environment only. No command takes one as a flag.

## 1. Install the platform

```bash
export FABRIKA_ZEROPS_ACCESS_TOKEN=<personal access token>
fabrika platform install --provider=zerops --create-project --client-id=<id> --env=<name>
```

`--create-project` creates the project with the two settings Zerops accepts at creation only: core
package `LIGHT` and `envIsolation: service`. Its id is printed before the wait, so an interrupted run
resumes with `--project-id=<id>`. To install into a project you created yourself, pass `--project-id`
instead; that project must be empty and carry both settings already.

The command confirms before every step that leaves the machine. A stdin that is not a terminal is
refused unless `--yes` is passed. It then imports the services without code, generates seven secrets,
mints the integration token, builds the proxy once to learn the three public hosts, writes every
variable, and runs the full ordered deploy.

Every secret is written to the environment of the Zerops service that uses it. Nothing is written to
disk, and the pipeline created in step 3 never sees those values.

**Capture the provisioning key.** The run ends with a box containing `FABRIKA_IAM_PROVISIONING_KEY=px_…`.
The CLI prints it once and keeps no copy. The only other copies are the `iam` and `control` services'
environments, readable by anyone with access to the Zerops project. Steps 2, 3 and 4 need it.

**Check.** The output lists `✓ iam <host>`, the console origin, and a ready-to-run `platform admin`
command. All five runtime services read `ACTIVE` in the Zerops GUI.

`install` refuses a project that already holds an installation's generated secrets, and refuses a
partial set of services. Update an existing installation through the sidecar pipeline (step 3), never
with a second `install`.

## 2. Admit the first administrator

Nobody can sign in until this runs. Authentication is password only after a fresh install.

```bash
export FABRIKA_IAM_PROVISIONING_KEY=<the key from step 1>
fabrika platform admin --provider=zerops --email=<address> --iam-host=<iam host from step 1>
```

It invites the principal, grants the cross-app `admin` role, and prints one password enrollment URL.
The URL is a credential: it is printed once and stored nowhere.

**Check.** Open the URL, set a password, and sign in at the console origin. Delivery, Access and
Operations all load. A re-run changes nothing and reports the outstanding enrollment; `--reissue`
replaces one that expired unopened.

## 3. Create the sidecar repository

The sidecar is a repository the operator owns. Its GitHub pipeline calls `fabrika platform deploy`, and
its `fabrika.ref` pins the fabrika tag the pipeline runs.

```bash
fabrika platform init --provider=zerops <installation>
```

`<installation>` names the GitHub Environment, the default repository
`contember/fabrika-zerops-<installation>`, and the local checkout directory. Pass
`--repo=<owner>/<name>` for a different repository.

`init` asks for the tag to pin, the Zerops project id, the environment name, and where the installation
answers (Zerops subdomains, or three custom hosts). It then asks for two secrets and generates neither:

| Secret                         | Where it comes from                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `FABRIKA_IAM_PROVISIONING_KEY` | The key `install` printed.                                                                                                                     |
| `FABRIKA_ZEROPS_ACCESS_TOKEN`  | The integration token `install` minted. Read it from the `control` service's environment in the Zerops GUI. Never use the personal token here. |

Both are sent to GitHub over `gh` stdin. `init` confirms before each outward step: reading the project,
configuring the `source` service, creating or pushing the repository, writing the Environment, and
triggering the first run. Declining stops there and prints the command to run instead. A re-run is safe.

**Check.** The `platform` workflow run in the sidecar repository ends green. Its first run changes
little, because step 1 already deployed the same code.

`init` ends with a block that names the variables step 4 needs and, when it can read it, exports the
IAM origin.

## 4. Mint a machine key

`fabrika control` authenticates with a machine key. Minting one presents the IAM RPC key as transport
authentication and the provisioning key as the issuing credential.

```bash
export FABRIKA_IAM_RPC_URL=<IAM's public origin, https://…>
export FABRIKA_IAM_RPC_KEY=<from the iam or control service's environment>
export FABRIKA_IAM_PROVISIONING_KEY=<the key from step 1>
fabrika control key issue --label=<name> --permissions=app.manage,namespace.manage,deploy.trigger,deploy.read
```

The permissions are control's actions: `app.manage`, `namespace.manage`, `deploy.trigger`,
`deploy.read`, `secret.manage`, `source.connection.manage`. Grant only what the client needs.

`FABRIKA_IAM_RPC_URL` is the public `https://` origin — the value `FABRIKA_IAM_ISSUER` holds on the
`control` service. The private `http://iam:3000` answers only inside the Zerops project.

For the remaining steps:

```bash
export FABRIKA_CONTROL_URL=<the console origin>
export FABRIKA_CONTROL_KEY=<the px_ key just issued>
```

**Check.** `fabrika control apps list` answers, with an empty list on a fresh installation.

## 5. Deploy the first application

The console covers this step too: **Namespaces** creates a placement, **Onboard an app** registers a
built manifest, and the app detail page deploys. The CLI sequence is the same procedures over the same
RPC contract ([ADR-0033](../decisions/0033-operate-the-control-plane-from-the-cli.md)).

1. **Connect a source, for a private repository.** In the console, open **Settings → Source** and
   create the organization's GitHub App. This is a browser flow only. A public repository needs no
   connection.
2. **Create a namespace.** A namespace is the Zerops project applications are placed in.

   ```bash
   fabrika control namespaces plan   --namespace=<id> --env=<name> --preset=cheap
   fabrika control namespaces create --namespace=<id> --env=<name> --preset=cheap
   fabrika control namespaces get    --namespace=<id>
   ```

   `create` returns while the state is `pending`; provisioning takes minutes. `get` reports the state
   and, once `ready`, the hosts the namespace serves and which are free. Presets and isolation are in
   [`deployment-namespaces.md`](deployment-namespaces.md).
3. **Build the manifest**, in the application's repository:

   ```bash
   fabrika app build --env=<name>
   ```

   It writes `fabrika.manifest.json`. [`examples/zerops-app`](../../examples/zerops-app/README.md) is a
   worked application.
4. **Register the application.**

   ```bash
   fabrika control register --provider=zerops --app=<id> --repo=<url> --env=<name> \
     --manifest=fabrika.manifest.json --namespace=<id> --domain=<a free host from step 2>
   ```

   `--domain` is required when the manifest publishes the application through the namespace proxy.
   `--installation-id=none` registers an anonymous public repository; omitting the flag resolves the
   installation from the organization's connected GitHub App. A changed manifest is applied later with
   `fabrika control apps environments put`, never with a second `register`.
5. **Deploy.**

   ```bash
   fabrika control deploy --app=<id> --env=<name>
   fabrika control runs list --app=<id>
   fabrika control runs log --run=<id>
   ```

   The deploy fails when the `zerops.yaml` at the resolved commit differs from the registered manifest;
   rebuild and re-apply the manifest in that case.

**Check.** The run ends `succeeded` and the application answers on its domain, behind the sign-in the
proxy enforces.

## 6. Upgrade the installation

```bash
fabrika platform upgrade --provider=zerops --to=<tag> <installation>
```

It checks that the tag is published, writes it to `fabrika.ref` in the sidecar checkout, commits,
pushes, prints the workflow run URL, and watches the run. The push is the trigger. `--dry-run` reports
the roll without committing. A redeploy at the same tag is _Actions → platform → Run workflow_ in the
sidecar repository.

The tag pins what the pipeline does. It does not pin the revision Zerops builds, because a Zerops build
source names a repository and not a revision; the sidecar's own README states the consequence.

## Where each credential lives

| Credential                        | Held by                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Zerops personal access token      | The operator only. Used by `install`, stored nowhere.                               |
| Zerops integration token          | The `control` service's environment, and the sidecar GitHub Environment.            |
| Provisioning key                  | The `iam` and `control` services' environments, and the sidecar GitHub Environment. |
| Signing keys, vault key, RPC keys | The environments of the services that use them. Nowhere else.                       |
| GitHub App private key            | The `source` service. The webhook secret is in control's vault.                     |
| Machine keys                      | Whoever they were issued to. `key issue` prints each one once.                      |

The vault key cannot be recovered or re-rolled. Losing the Zerops project's service environments loses
every secret the control plane holds.
