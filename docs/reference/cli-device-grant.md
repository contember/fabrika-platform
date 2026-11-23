# The command line's OAuth grant

A person can hand an agent or a script on their machine a narrow, expiring grant to the console instead of a
`px_` key. They approve it in the browser with their own IAM session. The grant then acts as that person, narrowed
to one preset at one application. The `fabrika` CLI obtains it with the RFC 8628 device grant, and the console's
two RPC paths accept its tokens. Read with [`mcp-authoring.md`](mcp-authoring.md), which describes the same
authorization server serving MCP clients.

## Where it is served

Every Zerops installation deployed over https serves it, and so does the local stack. A Cloudflare installation does
not serve it yet. The installation's IAM is the authorization server. It knows the command-line client as
`fabrika-cli`, a public client without a metadata document, and serves it two resources:

- `https://<console>/api/rpc`, Control's RPC;
- `https://<console>/operations/api/rpc`, Operations' RPC.

Each resource is served to one kind of client. These two go to the command-line client alone, through the device
grant; `/mcp` goes to the managed MCP clients alone, through an authorization code.

## Obtaining a grant

```bash
export FABRIKA_CONTROL_URL=https://<console>
export FABRIKA_CONTROL_CREDENTIAL_HELPER=<your helper>
fabrika control auth device --preset=deploy --app=<app id>
```

The CLI finds IAM from the console's origin alone. The resource metadata at
`/.well-known/oauth-protected-resource/api/rpc` names the authorization server, and that server's metadata names the
endpoints. It follows no redirect while it looks. It prints a page and a code on stderr. The person opens the page,
signs in, checks the code, and picks the grant's lifetime: an hour, a day or a week. The grant lasts no longer than
the IAM session that approved it.

| Preset    | On Control's RPC                                       | On Operations' RPC                     |
| --------- | ------------------------------------------------------ | -------------------------------------- |
| `read`    | `deploy.read`, `data.read` at the app                  | `operations.read` at the app           |
| `deploy`  | `read`, and `deploy.trigger`                           | `operations.read`                      |
| `operate` | `deploy`, and `secret.manage`, `app.manage`            | `operations.read`, `operations.triage` |
| `create`  | `app.manage` wherever the person holds it, with no app | not covered                            |

A token never holds more than the person who approved it. No preset carries access approval, namespaces, source
connections, mail or data content, and Control refuses a delegated token in every flow that needs the person
themselves (`isPerson`).

## The credential helper

The refresh token goes to the helper and nowhere else. It is never printed. `FABRIKA_CONTROL_CREDENTIAL_HELPER` names
a command, run as `sh -c '<helper> get'` or `sh -c '<helper> store'`, in the style of a git credential helper:

- `get` reads `origin=<console origin>` on stdin and prints `refresh_token=<token>`, or nothing when it holds none;
- `store` reads `origin=<console origin>` and `refresh_token=<token>` on stdin.

A helper that keeps the token in the operating system's secret store is a few lines of shell. `FABRIKA_CONTROL_KEY`
wins when both variables are set, so an existing setup does not change.

## Using it

`fabrika control`, `fabrika env`, `fabrika operations` and `fabrika connect` use the grant when no key is set. Each
process trades the refresh token for an access token for the resource it calls, and keeps that token in memory only.

IAM rotates the refresh token on every refresh, and treats a second use of a spent one as a replay that revokes the
grant. So the CLI refreshes under a lock file per console in `fabrika/control-credentials` under `$XDG_CACHE_HOME`
(`~/.cache` when it is unset). It takes the lock, runs `get`, refreshes, runs `store`, and releases the lock. Two
processes on one machine therefore rotate in turn; a lock whose process has died is taken over. The lock does not span
machines: two machines that share one stored token revoke their grant.

Some failures cannot be retried, and the CLI says so:

- **A lost answer.** The CLI never sends a device code or a refresh token a second time after an answer that did not
  arrive: IAM may have spent it. The grant is then gone, and `fabrika control auth device` starts a new one.
- **A failed `store`** after a successful refresh leaves only the spent token behind, with the same outcome.

## Ending a grant

A grant is bound to the IAM session that approved it, and IAM mints nothing for it once that session has ended. Signing
out ends it. So does an administrator revoking the session, or the person losing their access. The token can also be
revoked at IAM's revocation endpoint (RFC 7009), which revokes the whole grant. The console does not list grants yet.
