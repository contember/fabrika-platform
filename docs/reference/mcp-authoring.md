# MCP authoring

Employees edit an application from their own Claude or ChatGPT account. The client writes the code;
the platform authenticates the person, limits what they may change, deploys their work to a stage
environment, and opens a pull request. Production stays on the ordinary merge + Delivery path.
Decision: [ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md).

## Flow

1. The MCP client calls `https://<console>/mcp`. The proxy answers `401` with a `WWW-Authenticate`
   challenge that names the RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp`.
2. The metadata names IAM as the authorization server. The client runs OAuth 2.1 against IAM:
   authorization code with S256 PKCE, the RFC 8707 resource `https://<console>/mcp`, scope `authoring`.
   The user signs in to IAM and consents.
3. IAM mints an `at+jwt` access token for that one resource of the `vozka` app. Its permissions are
   the user's live grants narrowed by the `authoring` scope grant.
4. The console table's `mcp` row admits the `oauth` caller for that resource and scope. The proxy
   injects `X-Fabrika-Token` and `X-Fabrika-Endpoint`. Control verifies the token and makes no
   enforcement decision (ADR-0022).
5. Each MCP tool calls a Control use case. Control authorizes it against the token's permissions at
   the app/environment coordinates.
6. Control performs every Git read and write itself, through the GitHub App of the app's connection.
   The App key comes from Control's vault per operation (ADR-0029); the installation token stays inside
   the GitHub client and never reaches the MCP client.

A workspace is a branch `fabrika/<workspace id>` created from the default branch. Every edit is a
commit that names the expected head; a stale head fails and the client re-reads.

## Tools

| Tool                  | What it does                                                        |
| --------------------- | ------------------------------------------------------------------- |
| `list_targets`        | App environments the user may author.                               |
| `create_workspace`    | Create a workspace branch from the default branch.                  |
| `list_workspaces`     | The user's workspaces, each with head, latest run and pull request. |
| `get_workspace`       | One workspace, with its head, latest run and pull request.          |
| `get_workspace_diff`  | Files changed since the workspace base, optionally with patches.    |
| `list_files`          | A page of paths in the workspace, optionally to a depth.            |
| `read_files`          | File contents at the workspace head; an unread file says why.       |
| `search_files`        | Paths by glob, or lines holding a literal text, within bounds.      |
| `apply_changes`       | Commit writes, deletions and exact replacements against a head.     |
| `deploy_stage`        | Start an ordinary run for the workspace head in the stage env.      |
| `get_deployment`      | The run's state, a log window, approval link, `deviations`.         |
| `delete_workspace`    | Abandon a workspace: delete its branch and sandbox, stop listing.   |
| `create_pull_request` | Open a pull request from the workspace to the default branch.       |
| `get_app_rules`       | The application rules or one topic, read-only, with a pin warning.  |
| `bind_dev`            | Create or wake the workspace's dev sandbox; bootstrap if due.       |
| `get_dev_status`      | The dev sandbox's state, URL, served head, checks and a log window. |
| `run_checks`          | Run tests, `tsc` and `fabrika-check` in the dev sandbox; report.    |
| `reset_dev`           | Drop the sandbox's schema and roles, and migrate from scratch.      |

Every tool carries MCP tool annotations. A tool that only reads has `readOnlyHint: true`, so a client such as ChatGPT
does not ask the user to confirm it. A writing tool states `destructiveHint` (it can overwrite or delete files, or replace
what the stage environment runs) and `idempotentHint` (a repeated call has no further effect). No tool has
`openWorldHint`: every tool reaches only the target's repository and Control. The annotations are hints for the client;
Control authorizes every call.

`apply_changes` takes two kinds of change. `{ path, content }` writes the whole file, and `content: null` deletes it.
`{ path, oldString, newString }` replaces `oldString` in the file as it is at `expectedHeadSha`. Control refuses the
whole batch when `oldString` does not occur exactly once, or when the file is missing, binary, or over 512 KiB.
Several replacements on one path apply in order; a path written whole may appear only once. The protected paths and the
expected head apply to both kinds.

`search_files` reads the branch through the repository's tree and blobs; there is no search index. With `glob` alone it
lists matching paths from one tree listing. With `text` it reads at most 100 files the glob and `directory` admit, 2 MiB
together, and answers the lines that contain the literal text (no regular expressions: a pattern could hold Control's
event loop). It answers at most `maxResults` (default 50, at most 200), each line cut to 240 characters. `incomplete`
names every bound that cut the answer short. A text search costs one GitHub request per file read.

`get_workspace_diff` compares the live head with the workspace's base through GitHub's compare API. GitHub lists at most
300 changed files. With `includePatches`, a patch is at most 32 KiB and all patches together at most 256 KiB; `paths`
narrows which files carry one, and `incomplete` names the files left without a patch.

The authoring environment shows one workspace at a time. `list_targets` answers what it runs now as `deployed`: the last
successful run, the workspace whose branch it deployed (null for another branch), and whether that workspace is the
caller's. A workspace says the same as `onStage`. Each target names its `kind` (a stage environment is `standard`) and,
in `dev`, its application's dev environment when it has one the caller may read: the state, summary, URL and served head
of the caller's most recently active workspace sandbox there.

`get_workspace` and `list_workspaces` name the pull request that `create_pull_request` opened or found, as Control
recorded it; a pull request opened on GitHub by hand is not shown, and the record does not follow a merge or a close.
`list_workspaces` reads every listed workspace's head through one GitHub token per repository.

`delete_workspace` needs `source.workspace.write` and works on the caller's own workspace only. It deletes the branch
first, which closes an open pull request from it on GitHub, removes the workspace's dev sandbox, and then marks the
workspace abandoned: no list shows it and every other tool answers `410`. A failed delete leaves the workspace as it was, and a repeated call is harmless. The
stage environment keeps running what it last deployed; the runs of the branch stay readable.

`deploy_stage` answers the run with its id as `runId` too, the name `get_deployment` takes. `get_deployment` says whether
the run `finished` and gives a one-line `summary` of what its status means and what to do next; `run.exitCode` stays
null for a provider that runs no process, such as Zerops. Each provider step logs `→ <step>` when it starts and
`✓ <step> (<seconds>s)` or `✗ <step>: <error>` when it ends.

`get_deployment` answers a window of the build log, 30 lines by default and at most 500. `log.from` and `log.to` index
the log, which only grows: a client polls with `after: log.to` and gets only the new lines, or pages back with
`before: log.from`. `failuresOnly` keeps the lines that name an error, a failure or a non-zero exit, whichever stream
carries them: bun prints the commands it runs and its test output on stderr. A count of none (`0 fail`, `Found 0
errors`) is no failure, with or without color codes. The indexes still count every line, so a
client may switch the filter between polls without reading a line twice. `logLines: 0` answers the counts alone.

`get_app_rules` answers the application rules every agent gets, headed by their version (`fabrika-app <version>`):
the body of `@fabrika/app`'s `skill/SKILL.md`, or with `topic` one of its `references/<topic>.md`
([application runtime](application-runtime.md#the-agent-skill)). With `workspaceId` it reads that workspace's
`package.json` and warns when its `@fabrika/app` range does not admit the rules' version. Some clients cut server
`instructions` at about 2 KB, so the instructions stay under 2,000 characters: the workspace flow, a pointer to
`get_app_rules`, and three rules (each endpoint and every step off the paved road declared; never loosen anything to
make something pass; ask when a file is protected).

## The dev environment

An application may have one environment of kind `dev`
([ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md) rule 10), on Zerops only. Each workspace
gets its own **sandbox** in it, served at its own URL, `https://<workspace id>.<domain>`. A commit to the workspace
reaches its sandbox in seconds, without a run. `deploy_stage` stays the only path to a checked build, and nothing from a
sandbox is promoted.

A sandbox is a Zerops Box sandbox (a microVM) on the namespace's Box Workspace service, `zbox`. It runs the application
with its own PostgreSQL inside, so each workspace has its own data. The namespace proxy fronts every sandbox under its
own manifest entry, `dev:<app>:<workspace id>`
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md), "Dev sandbox entries"). All sandboxes of the
environment share one IAM application, `<app>@<env>`: a person's grants there apply in every sandbox, and the roles and
actions IAM knows are those of the workspace bootstrapped last.

1. `bind_dev` ensures the workspace's sandbox: it creates one when the workspace has none, creates it again when Box
   lost it, and wakes it. A bind starts a **bootstrap run** whenever the sandbox's launcher cannot serve the workspace:
   the first bind, a sandbox created again (it holds nothing), after a failed bootstrap or a refused sync, when the change from
   the head the sandbox holds to the workspace head needs one (below), when IAM holds another workspace's contract, when
   the IAM keys the sandbox holds have less than 15 days left, and when the launcher is gone: Control cannot read its requests, or it sent none for 90 s (15 min while it syncs or runs
   checks). A bind that wakes a parked sandbox waits up to 15 s for the launcher's first request. A bootstrap run is an
   ordinary run of the workspace head with every check, which `get_deployment` follows (`bootstrapRun.id`). Its lane is
   the workspace, so it never supersedes or fails another workspace's run; the bootstraps of one environment still run
   one at a time. Binding one workspace never touches another's sandbox.
2. `apply_changes` commits as always. When the workspace has a sandbox, Control records the new head, and the
   launcher's long poll on Control's public origin (the `source` receiver,
   [ADR-0064](../decisions/0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md) §7, with a key
   bound to the workspace) answers with the changed files: the ones `apply_changes` just wrote, handed over in memory
   when the same Control process holds the wait, or else read from a GitHub compare. They are never stored.
3. The launcher writes the files, migrates when `db/migrations/` changed, runs the authored SPA commands when a file
   outside `src/` and `db/` changed (beside the contract digest; a refusal rebuilds over the restored files), restarts
   the application and waits for its health endpoint. It reports the head, its status and the last lines of output.
4. `apply_changes` waits up to 10 s for that report and answers `dev: { head, state, summary, url, log }` beside
   `commitSha`; `url` is the sandbox's origin. On a timeout `state` is `pending`, and `get_dev_status` reads the rest.
   Once the commit persisted, the call never fails: when following the sandbox fails, `state` is `unavailable` with a
   `reference`, and when the audit entry cannot be written the answer carries a `warning` with a reference. Advancing
   or waking the sandbox needs `deploy.trigger` on the environment, as `bind_dev` does; a caller who holds only
   `deploy.read` gets `state` `not_followed`, and the sandbox keeps its head.

`state` is one of:

| State              | Meaning                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unbound`          | The workspace has no sandbox yet; call `bind_dev`.                                                                                                                                           |
| `bootstrapping`    | The bootstrap run has not finished.                                                                                                                                                          |
| `bootstrap_failed` | The bootstrap run failed; fix the cause and call `bind_dev` again.                                                                                                                           |
| `stopped`          | Parked after 30 minutes without activity; the next `apply_changes` or `bind_dev` wakes it, and so does a request to its URL.                                                                 |
| `pending`          | The launcher has not reported the newest commit yet.                                                                                                                                         |
| `syncing`          | The launcher is applying a commit.                                                                                                                                                           |
| `serving`          | `head` serves and answers its health endpoint.                                                                                                                                               |
| `failed`           | `head` does not serve: a migration, the schema check, the SPA build or the start failed; `message` says which.                                                                               |
| `needs_bootstrap`  | The commit changes what the build owns, Control cannot relay it, or the launcher is gone (Control cannot read it, or it went silent); `message` says why, and `apply_changes` does not wait. |
| `resetting`        | `reset_dev` is dropping and migrating the schema.                                                                                                                                            |
| `checking`         | `run_checks` is running.                                                                                                                                                                     |

When the workspace's contract differs from the one IAM last received, the summary adds that roles and actions follow
the most recently bootstrapped workspace, and that `bind_dev` refreshes them.
When the IAM keys the sandbox holds (its webhooks', public procedures', imports' and membership key) have less than 15
days left, or have expired, the summary says so and that `bind_dev` refreshes them. Only a bind does: a sandbox that
keeps receiving commits without one runs until its keys expire. One left untouched is removed after 14 days, before
then.

A commit **needs a bootstrap run** when it changes `package.json`, `bun.lock`, `bunfig.toml`, a `zerops.yaml`, anything
under `fabrika/` or another `fabrika.*` file, when it changes the contract digest, or when the change is more than 300
files or 8 MiB, or holds a binary or oversized file. The launcher computes the digest after writing the files, in a
child with no credential, and compares it with the one the bootstrap run deployed; a commit that changes it is
restored and refused. An edit of a handler, its wording or its logic, syncs even in a module the contract imports.
The launcher keeps serving the head it has, and `bind_dev` starts the bootstrap.

`get_dev_status` answers a window of the launcher's and the application's output since the newest sync or reset (at most
200 lines); `apply_changes` answers the newest 20 of them. The window is indexed by the launcher's line numbers, so
`after: log.to` stays put across reports; a smaller `log.total` means a new launcher. A bootstrap bind drops the
previous launcher's log and check results. Bun's echo of the script it runs (`$ bun build-web.ts`) is reported on
stdout. The launcher never reports the environment. `run_checks` runs the build's check
chain on the files the sandbox holds and waits up to 50 s for the results; they gate nothing. It is refused while the
sandbox holds another commit than the workspace's newest, and `checks.head` names the commit the results are for. Each
result carries its exit code, `durationMs` and the last lines of its output. A check killed by a signal (the
out-of-memory killer, or the launcher's 10-minute timeout) has `exitCode: null`, fails, and its last output line says
so. `reset_dev` drops the schema and role family in the sandbox's own PostgreSQL and migrates from scratch; other
workspaces keep their data. Call it after editing a migration that was already applied, which otherwise fails the sync.
`bind_dev`, `run_checks` and `reset_dev` need `deploy.trigger`; `get_dev_status` needs `deploy.read`.

### Inside a sandbox

A bootstrap deploys into the sandbox, not through a Zerops build. The provider wakes the sandbox, stops the previous
launcher and build, uploads its helper scripts and the source archive of the exact commit (at most 50 MiB), and runs the
build (the authored SPA commands, then `@fabrika/app/build`'s steps with every check) as an unprivileged user with a
clean environment: the build reads no credential and cannot log in to PostgreSQL. Its output reaches the run log with
every environment value masked. Only then does it write the launcher's environment to a root-only file, start the
launcher, and wait up to 180 s for it to report its boot. A run whose invocation is lost settles failed; bind again.

At boot (after a bootstrap or a restart) the launcher reconciles to the recorded head before it serves. It migrates and
checks the schema types (`fabrika db codegen --verify`) itself, after Control's answer, because the sandbox's database
still holds what the previous bootstrap left: it first runs any reset still pending. A migration or check that fails at
boot, over an applied migration the commit edited, is the `failed` state, and its message names `reset_dev`; the
launcher still reports its boot, so the bootstrap run completes and `reset_dev` reaches the launcher. The generated
isolation tests (`fabrika db test-isolation`) run in a stage build, not in a sandbox.

A sandbox gives an application less than a Zerops service:

- A bootstrap refuses, in one line each, runtime packages (`runtimePackages`), object storage, the ClamAV scan (a
  contract with `scan: true`), and a variable or secret whose value holds a `${…}` reference.
- Jobs do not run: a sandbox has no crontab. A stage environment (`deploy_stage`) runs them.
- The Box router strips `Authorization` before the request reaches the application. A key caller's request therefore
  looks like a session's: a non-`GET` request with a `px_` key fails admission, and a webhook verified by a bearer or a
  basic credential fails. Use a session in the browser, and `deploy_stage` for webhooks and key callers.
- The environment's app secrets are kept in Control's vault and handed to the sandbox at each bootstrap.

### Idle and removal

Control parks a sandbox after 30 minutes without activity. A request to its URL wakes it in about a second, and
every `apply_changes`, `bind_dev`, `reset_dev` and `run_checks` wakes it itself. Maintenance removes a sandbox whose
workspace saw no activity for 14 days, unless a bind or commit made it active again before the removal began, and one
a `bind_dev` left creating for an hour; the workspace stays, and the next `bind_dev` creates a new sandbox with an empty database. `delete_workspace` removes the
workspace's sandbox at once, and maintenance also removes any sandbox of an abandoned workspace. A removal stops the
proxy routing the sandbox's host, deletes the Box sandbox and revokes the workspace's `source` keys, then deletes its
proxy secret and record, and republishes the namespace proxy. When Box fails, the keys are still revoked and the
proxy still republished; the record stays for maintenance to finish, and the workspace is abandoned all the same. While
a workspace of the authoring environment has a sandbox, that environment cannot be deleted either. A `bind_dev` on a
namespace whose proxy is pinned to a release that cannot serve sandboxes is refused with the re-pin command, and records
nothing. When the Box host has no room for one more running sandbox, `bind_dev` says so: abandon idle workspaces,
or ask the operator to size the `zbox` service.

## Failures

A refused call is a tool error with one short line. A failure the client did not cause says what failed and whether a
retry helps, and never carries upstream text, which may hold a token or a clone URL:

- **GitHub refused** the app's GitHub App (its installation, permissions or key, or a protected branch): retrying does
  not help, and the operator must act.
- **GitHub is unavailable or rate-limited** (a 5xx, a timeout, or a 403, which GitHub also answers for its secondary
  rate limit): retry in a minute.
- **The deploy queue or the run log store failed**: the message names the store. A queue failure after the run was
  created says so, so the client knows a retry creates another run.
- **Anything else** (Control's database, the audit log in IAM, a fault in Control): retry in a minute. The message carries
  a reference that Control's log names beside the error's class.

## Enable it on an installation

1. **Register the MCP clients.** Set `FABRIKA_PLATFORM_MCP_CLIENTS_JSON` in the sidecar's GitHub
   Environment (or pass `--mcp-clients=<json>` to `fabrika platform deploy --provider=zerops`):

   ```json
   [{
   	"provider": "claude",
   	"clientId": "<https CIMD URL>",
   	"redirectUris": ["<https callback>"]
   }]
   ```

   `metadataUrl` is optional; IAM fetches the client id when it is absent. The deploy refuses a
   malformed list, more than 16 clients, or `--scheme=http`, before it writes anything. Register
   [Claude and ChatGPT](#registering-claude-and-chatgpt) as below. With the list, the deploy:
   - publishes the console's MCP table, whose `/mcp` row admits OAuth bearers, and registers the
     resource in the proxy manifest;
   - writes `FABRIKA_SERVICE_TABLE_DIGEST` on `control`: the digest of that table. Control serves
     `/mcp` exactly when it names the MCP table, and refuses to start when it names neither table;
   - writes `FABRIKA_IAM_OAUTH_CONFIG` on `iam`: the clients, and the resource `https://<console>/mcp`
     whose `authoring` scope grants `source.workspace.read`, `source.workspace.write`,
     `source.pull-request.create`, `deploy.trigger` and `deploy.read`.

   Without the list, the console's table makes `/mcp` a session-only row that Control answers `404`,
   so no OAuth client reaches it. The
   deploy then leaves `FABRIKA_IAM_OAUTH_CONFIG` on `iam` as it is and warns that it is still set;
   delete it there to stop IAM issuing tokens.

   **A sidecar generated before this variable existed does not forward it** until its workflow is
   regenerated: `platform upgrade` and `platform init` both rewrite `.github/workflows/platform.yml`
   to the one their CLI generates. Until then, add this line by hand to the `env:` of the
   _Deploy the platform_ step, next to `FABRIKA_ZEROPS_API_URL`:

   ```yaml
   FABRIKA_PLATFORM_MCP_CLIENTS_JSON: ${{ vars.FABRIKA_PLATFORM_MCP_CLIENTS_JSON }}
   ```
2. **Give the GitHub App write access.** It needs `contents: write` and `pull_requests: write` on
   the application's repository: a workspace is a branch Control commits to, and `open_pull_request`
   opens a pull request. An App created from the console asks for both. An App created before MCP
   authoring has `contents: read` only: raise both in the App's settings on GitHub. GitHub then asks the
   owner of each installation (the organization owner) to accept the new permissions, and the App keeps its
   old ones until they do.
3. **Mark one non-production environment as the authoring target** through `apps.environments.put`
   with `authoring: true`. Only an environment of an app with a GitHub connection, on a provider that declares
   `authoring` (Zerops today), is accepted.
   Control refuses a second authoring environment for the same app (`409`); clear the flag on the
   first one before moving it. Never mark production: `deploy_stage` deploys unreviewed workspace
   heads to the authoring environment.
4. **Grant the users** `source.workspace.read`, `source.workspace.write`,
   `source.pull-request.create`, `deploy.trigger` and `deploy.read`, scoped to the app. The token
   carries the intersection of these grants and the scope grant above.
5. **Optionally, register a dev environment**:
   `fabrika control apps environments put --provider=zerops --app=<id> --env=<name> --manifest=<path> --kind=dev --domain=<base>`.
   `<base>` is a wildcard base such as `dev.example.com`: workspace `W` is served at `W.<base>`. Point DNS for
   `*.<base>` at the namespace's `proxy` service and bind it there, as for any custom domain (whether Zerops issues a
   certificate for a wildcard domain is not verified live). Control refuses the environment on a provider without dev
   environments (Cloudflare), without a domain, on an app without a GitHub connection, under the name `prod`, as an
   authoring target, with a trigger ref, and as a second dev environment of the app. Its namespace's environment must
   equal the environment's name, as for any environment, and the namespace must publish custom domains: a
   `zerops-subdomain` namespace is refused. The namespace's proxy must be built from a source that understands sandbox
   entries; otherwise every namespace job that would publish a sandbox entry, a bootstrap run's republish included,
   fails before any platform write and names
   `fabrika control namespaces update --namespace=<id> --proxy-source=current`. The first `bind_dev` in the namespace
   republishes it before creating its sandbox, and that namespace job creates the namespace's Box host (`zbox`), keys it
   with a key Control generates and keeps in its vault, and restarts it; a busy namespace answers a 503 to retry. The
   first sandbox builds the base image on the host. A dev environment claims no
   Zerops service. Its app secrets live in Control's vault (`fabrika control apps secrets put … --env=<name>`), and
   each bootstrap hands them to the sandbox. Deleting the environment, or its app, is refused while a workspace sandbox
   of it is left: abandon those workspaces (`delete_workspace`), or wait for maintenance to remove idle ones. The application must pin `@fabrika/app` 0.9.0 or newer; the bootstrap run
   of an older release is refused before anything publishes, and the application keeps `deploy_stage`. Control needs
   its public origin (`FABRIKA_CONTROL_DOMAIN`) and its vault for the sandbox host key, the proxy secrets and the
   `source` keys.

### Upgrading an installation with a dev environment

A `dev` environment registered before sandboxes ran on one Zerops service of its own and is not migrated. The upgrade
drops Control's record of it (its bound workspace, target head and launcher report). `bind_dev` and a dev deploy refuse
it and say to delete it and register it again with `--kind=dev` and a wildcard domain. Until the operator acts, its
namespace resource claims stay held; the next republish of its namespace stops routing its old domain, because a `dev`
environment is served only through workspace sandboxes. No deploy writes to the old service again, so its variables,
app secrets included, stay until it is deleted. After `fabrika platform upgrade`:

1. Re-pin each namespace that will hold a dev environment:
   `fabrika control namespaces update --namespace=<id> --proxy-source=current`. Its proxy then reads sandbox entries.
2. Remove the old dev environment as any environment is removed
   ([deployment namespaces](deployment-namespaces.md#releasing-a-claim)): delete its Zerops service, release its
   namespace resource claims (`fabrika control namespaces release-claims --namespace=<id> --app=<id> --env=<name>`),
   then delete the environment (`apps.environments.delete`).
3. Register it again with `--kind=dev` and a wildcard domain (step 5 above), and set up DNS for `*.<base>`.
4. Set the environment's app secrets again (`fabrika control apps secrets put --app=<id> --name=<name> --env=<name>`).
   They now live in Control's vault; a secret row that still names a Zerops variable fails the bootstrap with "set its
   value again".
5. Each author calls `bind_dev` again; the first bind bootstraps the workspace's new sandbox.

Namespaces without a dev environment need none of this: no Box host is created and no manifest entry changes.

## Registering Claude and ChatGPT

Each entry names one client id and its exact redirect URIs. IAM fetches the client's metadata document at
the client id, and a document that names any other redirect URI is refused.

| Client             | `clientId`                                            | `redirectUris`                                          |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------- |
| Claude             | `https://claude.ai/oauth/mcp-oauth-client-metadata`   | `https://claude.ai/api/mcp/auth_callback`               |
| ChatGPT (stable)   | `https://chatgpt.com/oauth/client.json`               | `https://chatgpt.com/connector_platform_oauth_redirect` |
| ChatGPT (fallback) | `https://chatgpt.com/oauth/<callback id>/client.json` | `https://chatgpt.com/connector/oauth/<callback id>`     |

```json
[
	{
		"provider": "claude",
		"clientId": "https://claude.ai/oauth/mcp-oauth-client-metadata",
		"redirectUris": ["https://claude.ai/api/mcp/auth_callback"]
	},
	{
		"provider": "chatgpt",
		"clientId": "https://chatgpt.com/oauth/client.json",
		"redirectUris": ["https://chatgpt.com/connector_platform_oauth_redirect"]
	}
]
```

- **ChatGPT uses the stable client id** because IAM supports RFC 9207: it advertises
  `authorization_response_iss_parameter_supported` and puts `iss` on every authorization response. Register the
  stable entry; no per-connector step is needed.
- **The fallback client id** belongs to one connector. ChatGPT uses it only against an authorization server
  without RFC 9207. The `<callback id>` appears in the connector's settings after it is created. Add one entry
  per connector:

  ```json
  {
  	"provider": "chatgpt",
  	"clientId": "https://chatgpt.com/oauth/<callback id>/client.json",
  	"redirectUris": ["https://chatgpt.com/connector/oauth/<callback id>"]
  }
  ```

**Client authentication follows the document.** Claude's document declares `token_endpoint_auth_method: none`:
a public client with PKCE. ChatGPT's declares `private_key_jwt`: at the token and revocation endpoints it sends a
JWT client assertion (RFC 7523) signed with a key from the document's `jwks_uri`. IAM then requires the
assertion and never accepts a request without one from that client. IAM verifies:

- the key set URL is HTTPS on the client id's own origin, or the document is refused;
- the signature, with the document's `token_endpoint_auth_signing_alg` (`RS256` is the one IAM supports);
- `iss` = `sub` = the client id;
- `aud` is the token endpoint URL or IAM's issuer identifier; at `/oauth/revoke` also the revocation endpoint URL;
- `exp` is present, not passed, and at most one hour ahead;
- `jti` is present and was not presented before (`oauth_client_assertions`, kept until `exp`).

IAM caches a key set for five minutes. An assertion with an unknown `kid` refetches it, at most once per 30 s.

A revocation without an assertion needs only a registered client id, as RFC 7009 allows a public client: it revokes
only a token bound to that client, so it never waits on the document's host. It is refused when the document is
known to declare `private_key_jwt`.

## Locally

The local stack runs MCP off. Set `FABRIKA_LOCAL_MCP_CLIENTS_JSON` (same shape) before
`bun run local:up` to turn it on; the resource is then `http://control.fabrika.localhost:18080/mcp`.
Every prepare rewrites `.state/control-table.env` with the matching table digest, so Control follows.
IAM still fetches each client's CIMD document over HTTPS, and a hosted client cannot reach a
`localhost` resource, so this checks configuration rather than a full client session.

## Protected paths

`apply_changes` refuses the provider's deploy files (`ControlProvider.authoring.protectedFiles`: Zerops'
`zerops.yaml` and `zerops.yml`) at any depth, every `fabrika.*` file except `fabrika.contract.ts`, and everything
under `.github/`. The operator changes them through normal review.

The contract, its schema modules, `src/db/tables.ts` and `db/migrations/` are editable: Control classifies
their change at deploy time ([ADR-0050](../decisions/0050-approved-access.md)). The authoring target is
unprotected by default, so a change applies there at once. When a widening reaches a protected
environment, `get_deployment` reports the run as `awaiting_approval` with the console's approval link and the
change in plain language. No OAuth or MCP token can approve it. Its `deviations` name the lines that step off the
paved road and need closer review, parked or not.

## Limits

- An access token stays valid until it expires, at most 300 s after a grant or session is revoked.
  Revocation stops refresh and new code exchanges.
- Zerops only.
- One authoring environment per app, never production; it shows one workspace at a time.
- One dev environment per app, never production or protected, on Zerops only; each workspace gets its own sandbox,
  and the sandboxes share one IAM application. In a sandbox jobs do not run and `Authorization` does not reach the
  application.
- Production is a human merge in GitHub followed by the existing Delivery trigger.
