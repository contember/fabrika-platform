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
4. The proxy's `oauth` gate on `/mcp` admits the bearer for that resource and scope and injects
   `X-Fabrika-Token`. Control verifies the token and evaluates no gate (ADR-0022).
5. Each MCP tool calls a Control use case. Control authorizes it against the token's permissions at
   the app/environment coordinates.
6. Control performs every Git read and write itself, through the GitHub App of the app's connection.
   The App key comes from Control's vault per operation (ADR-0029); the installation token stays inside
   the GitHub client and never reaches the MCP client.

A workspace is a branch `fabrika/<workspace id>` created from the default branch. Every edit is a
commit that names the expected head; a stale head fails and the client re-reads.

## Tools

| Tool                  | What it does                                                   |
| --------------------- | -------------------------------------------------------------- |
| `list_targets`        | App environments the user may author.                          |
| `create_workspace`    | Create a workspace branch from the default branch.             |
| `list_workspaces`     | The user's workspaces on a target.                             |
| `get_workspace`       | One workspace, with its head.                                  |
| `list_files`          | Paths in the workspace.                                        |
| `read_files`          | File contents at the workspace head.                           |
| `apply_changes`       | Commit file writes and deletions against an expected head.     |
| `deploy_stage`        | Start an ordinary run for the workspace head in the stage env. |
| `get_deployment`      | The state of that run.                                         |
| `create_pull_request` | Open a pull request from the workspace to the default branch.  |
| `get_app_rules`       | The application rules, read-only.                              |

`get_app_rules` answers the application rules every agent gets: the body of `@fabrika/app`'s `skill/SKILL.md`
([application runtime](application-runtime.md#the-agent-skill)). Some clients cut server `instructions` at about
2 KB, so the instructions stay under 2,000 characters: the workspace flow, a pointer to `get_app_rules`, and three
rules (contract first; never loosen anything to make something pass; ask when a file is protected).

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
   malformed list, more than 16 clients, or `--scheme=http`, before it writes anything. With the
   list, the deploy:
   - gates `/mcp` on the console for OAuth bearers and registers the resource in the proxy manifest;
   - writes `FABRIKA_IAM_OAUTH_CONFIG` on `iam`: the clients, and the resource `https://<console>/mcp`
     whose `authoring` scope grants `source.workspace.read`, `source.workspace.write`,
     `source.pull-request.create`, `deploy.trigger` and `deploy.read`.

   Without the list, `/mcp` falls to the console's human gate, so no OAuth client reaches it. The
   deploy then leaves `FABRIKA_IAM_OAUTH_CONFIG` on `iam` as it is and warns that it is still set;
   delete it there to stop IAM issuing tokens.

   **An existing sidecar does not forward the variable.** `platform upgrade` only bumps
   `fabrika.ref`; it never rewrites the workflow. Add this line by hand to the `env:` of the
   _Deploy the platform_ step in `.github/workflows/platform.yml`, next to `FABRIKA_ZEROPS_API_URL`:

   ```yaml
   FABRIKA_PLATFORM_MCP_CLIENTS_JSON: ${{ vars.FABRIKA_PLATFORM_MCP_CLIENTS_JSON }}
   ```
2. **Give the GitHub App write access.** It needs `contents: write` and `pull_requests: write` on
   the application's repository.
3. **Mark one non-production environment as the authoring target** through `apps.environments.put`
   with `authoring: true`. Only a Zerops environment of an app with a GitHub connection is accepted.
   Control refuses a second authoring environment for the same app (`409`); clear the flag on the
   first one before moving it. Never mark production: `deploy_stage` deploys unreviewed workspace
   heads to the authoring environment.
4. **Grant the users** `source.workspace.read`, `source.workspace.write`,
   `source.pull-request.create`, `deploy.trigger` and `deploy.read`, scoped to the app. The token
   carries the intersection of these grants and the scope grant above.

## Locally

The local stack runs MCP off. Set `FABRIKA_LOCAL_MCP_CLIENTS_JSON` (same shape) before
`bun run local:up` to turn it on; the resource is then `http://control.fabrika.localhost:18080/mcp`.
IAM still fetches each client's CIMD document over HTTPS, and a hosted client cannot reach a
`localhost` resource, so this checks configuration rather than a full client session.

## Protected paths

`apply_changes` refuses `zerops.yaml` and `zerops.yml` at any depth, any `fabrika.*` file, and
everything under `.github/`. The operator changes them through normal review.

## Limits

- An access token stays valid until it expires, at most 300 s after a grant or session is revoked.
  Revocation stops refresh and new code exchanges.
- Zerops only.
- One authoring environment per app, never production; it shows one workspace at a time.
- Production is a human merge in GitHub followed by the existing Delivery trigger.
