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
| `delete_workspace`    | Abandon a workspace: delete its branch and stop listing it.         |
| `create_pull_request` | Open a pull request from the workspace to the default branch.       |
| `get_app_rules`       | The application rules or one topic, read-only, with a pin warning.  |
| `bind_dev`            | Bind the workspace to the app's dev environment; bootstrap if due.  |
| `get_dev_status`      | The dev environment's state, served head, checks and a log window.  |
| `run_checks`          | Run tests, `tsc` and `fabrika-check` in the dev container; report.  |
| `reset_dev`           | Drop the dev schema and roles, and migrate from scratch.            |

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
in `dev`, its application's dev environment when it has one the caller may read: its state, summary, URL, served head
and bound workspace.

`get_workspace` and `list_workspaces` name the pull request that `create_pull_request` opened or found, as Control
recorded it; a pull request opened on GitHub by hand is not shown, and the record does not follow a merge or a close.
`list_workspaces` reads every listed workspace's head through one GitHub token per repository.

`delete_workspace` needs `source.workspace.write` and works on the caller's own workspace only. It deletes the branch
first, which closes an open pull request from it on GitHub, and then marks the workspace abandoned: no list shows it and
every other tool answers `410`. A failed delete leaves the workspace as it was, and a repeated call is harmless. The
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
([ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md) rule 10). A commit to the workspace bound
to it serves in seconds, without a run. `deploy_stage` stays the only path to a checked build, and nothing from the dev
environment is promoted.

1. `bind_dev` binds the workspace. The first bind, a bind after a failed bootstrap and a bind after a refused sync start
   a **bootstrap run**: an ordinary run of the workspace head with every check, which `get_deployment` follows
   (`bootstrapRun.id`). Its service starts the dev launcher instead of the serving entry. Binding another workspace
   replaces the bound one, syncs its tree and resets the schema; the answer says whose workspace was bound (`yours`).
2. `apply_changes` commits as always. When the workspace is bound, Control records the new head and the launcher's long
   poll on Control's public origin (the `source` receiver,
   [ADR-0064](../decisions/0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md) §7) answers
   with the changed files: the ones `apply_changes` just wrote, handed over in memory when the same Control process
   holds the wait, or else read from a GitHub compare. They are never stored.
3. The launcher writes the files, migrates when `db/migrations/` changed, runs the authored SPA commands when a file
   outside `src/` and `db/` changed (beside the contract digest; a refusal rebuilds over the restored files), restarts the application and waits for its health endpoint. It reports the head,
   its status and the last lines of output.
4. `apply_changes` waits up to 10 s for that report and answers `dev: { head, state, summary, url, log }` beside
   `commitSha`. On a timeout `state` is `pending`, and `get_dev_status` reads the rest.

`state` is one of:

| State              | Meaning                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `unbound`          | No workspace is bound.                                                                       |
| `bootstrapping`    | The bootstrap run has not finished.                                                          |
| `bootstrap_failed` | The bootstrap run failed; fix the cause and call `bind_dev` again.                           |
| `stopped`          | Stopped after 30 minutes without a sync; the next `apply_changes` or `bind_dev` starts it.   |
| `pending`          | The launcher has not reported the newest commit yet.                                         |
| `syncing`          | The launcher is applying a commit.                                                           |
| `serving`          | `head` serves and answers its health endpoint.                                               |
| `failed`           | `head` does not serve: a migration, the SPA build or the start failed; `message` says which. |
| `needs_bootstrap`  | The commit changes what the build owns, or Control cannot relay it; `message` says why.      |
| `resetting`        | `reset_dev` is dropping and migrating the schema.                                            |
| `checking`         | `run_checks` is running.                                                                     |

A commit **needs a bootstrap run** when it changes `package.json`, `bun.lock`, `bunfig.toml`, a `zerops.yaml`, anything
under `fabrika/` or another `fabrika.*` file, when it changes the contract digest, or when the change is more than 300
files or 8 MiB, or holds a binary or oversized file. The launcher computes the digest after writing the files, in a
child with no credential, and compares it with the one the bootstrap run deployed; a commit that changes it is
restored and refused. An edit of a handler, its wording or its logic, syncs even in a module the contract imports.
The launcher keeps serving the head it has, and `bind_dev` starts the bootstrap.

`get_dev_status` answers the window of the launcher's ring buffer of the application's and its own output, indexed like
`get_deployment` (at most 200 lines). The launcher never reports the environment. `run_checks` runs the build's check
chain on the files the container holds and waits up to 50 s for the results; they gate nothing. It is refused while the
container holds another commit than the workspace's newest, and `checks.head` names the commit the results are for. Each result carries its exit code, `durationMs` and the last
lines of its output. `reset_dev` drops the
environment's schema and role family and migrates from scratch; call it after editing a migration that was already
applied, which otherwise fails the sync. `bind_dev`, `run_checks` and `reset_dev` need `deploy.trigger`; `get_dev_status`
needs `deploy.read`.

At boot (after an idle stop, a restart or a new container) the launcher reconciles to the recorded head before it
serves.

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
   with `authoring: true`. Only a Zerops environment of an app with a GitHub connection is accepted.
   Control refuses a second authoring environment for the same app (`409`); clear the flag on the
   first one before moving it. Never mark production: `deploy_stage` deploys unreviewed workspace
   heads to the authoring environment.
4. **Grant the users** `source.workspace.read`, `source.workspace.write`,
   `source.pull-request.create`, `deploy.trigger` and `deploy.read`, scoped to the app. The token
   carries the intersection of these grants and the scope grant above.
5. **Optionally, register a dev environment**:
   `fabrika control apps environments put --provider=zerops --app=<id> --env=<name> --manifest=<path> --kind=dev`.
   Control refuses it on a provider without dev environments (Cloudflare), on an app without a GitHub connection, under
   the name `prod`, as an authoring target, with a trigger ref, and as a second dev environment of the app. Its
   namespace's environment must equal the environment's name, as for any environment. The application must pin
   `@fabrika/app` 0.9.0 or newer; the bootstrap run of an older release is refused before anything publishes, and the
   application keeps `deploy_stage`. In a `zerops-subdomain` namespace the dev environment takes one of the six proxy
   hosts. Control needs its public origin (`FABRIKA_CONTROL_DOMAIN`) and its vault for the `source` key.

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

## Locally

The local stack runs MCP off. Set `FABRIKA_LOCAL_MCP_CLIENTS_JSON` (same shape) before
`bun run local:up` to turn it on; the resource is then `http://control.fabrika.localhost:18080/mcp`.
Every prepare rewrites `.state/control-table.env` with the matching table digest, so Control follows.
IAM still fetches each client's CIMD document over HTTPS, and a hosted client cannot reach a
`localhost` resource, so this checks configuration rather than a full client session.

## Protected paths

`apply_changes` refuses `zerops.yaml` and `zerops.yml` at any depth, every `fabrika.*` file except
`fabrika.contract.ts`, and everything under `.github/`. The operator changes them through normal review.

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
- One dev environment per app, never production or protected, on Zerops only; it shows one workspace at a time and
  runs on one container.
- Production is a human merge in GitHub followed by the existing Delivery trigger.
