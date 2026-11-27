# The command line's OAuth grant

A person can hand an agent or a script on their machine a narrow, expiring grant to the console instead of a
`px_` key. They approve it in the browser with their own IAM session. The grant then acts as that person, narrowed
to one preset at one application. The `fabrika` CLI obtains it with the RFC 8628 device grant, and the console's
two RPC paths accept its tokens. Read with [`mcp-authoring.md`](mcp-authoring.md), which describes the same
authorization server serving MCP clients.

## Where it is served

Every Zerops installation deployed over https serves it, every Cloudflare installation does, and so does the local
stack. An existing Cloudflare installation also needs its `platform.yml` regenerated before Operations accepts the
grant ([release process](release-process.md)). The installation's IAM is the authorization server. It knows the command-line client as
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

## An application environment

A person can also hand an agent a grant to one deployed application environment
([ADR-0090](../decisions/0090-a-device-grant-reaches-an-application-as-the-person.md)). The client is `agent-cli`, a
second public client without a metadata document, served application resources alone. The resource is the
environment's origin, `https://<host>`, and it is one while a group of the environment's approved contract lists the
caller `agent`. Its metadata is at `https://<host>/.well-known/oauth-protected-resource`.

The grant holds one scope:

| Scope                                                   | Reaches                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `read` (the default)                                    | the queries and downloads of every group that lists `agent`              |
| `write`                                                 | their mutations and uploads too; refused until the environment allows it |
| `read:<dimension>=<value>`, `write:<dimension>=<value>` | as above, with the person's permissions narrowed to that one value       |

The device page shows the scope, and the narrowed actions for a narrowed one; the person may approve `read` for a
`write` request, never the reverse. An environment serves `write` where Control's `agent-write` gate in IAM is
`open`: unprotected, or protected with `agent-write` `off` and no passkey. Under the strict default (`off` with a
passkey) Allow on a `write` request asks the person's passkey first, bound to the attempt, the scope and the lifetime;
the grant records it, and a `write` grant without it is not served there. A person without a passkey is offered `read`,
with a link to add one on the IAM account page. An environment with no gate mirrored serves `read` only. IAM reads the gate at every exchange, so a tightened gate refuses a `write` grant's
next token (`write_refused`).

Any RFC 8628 client obtains it. The `fabrika` CLI has no command for an application grant yet; the requests below
drive it with curl. Every request is a form post (`application/x-www-form-urlencoded`) without a client secret, every
answer is JSON, and an error answers `{ "error": "<code>" }` with status 400 (401 for `invalid_client`). Follow no
redirect: a 3xx is a failure.

1. **Discovery.** `GET https://<host>/.well-known/oauth-protected-resource` names the authorization server in
   `authorization_servers[0]`, the issuer. `GET <issuer>/.well-known/oauth-authorization-server` names the endpoints;
   on an installation they are `<issuer>/oauth/device_authorization`, `<issuer>/oauth/token` and `<issuer>/oauth/revoke`.

2. **Device authorization.** `scope` is one token from the table above, `read` when omitted. `agent_label` is the name
   the application shows for the agent: not blank, no surrounding space, no control character, at most 64 characters.

   ```bash
   curl -sS "$ISSUER/oauth/device_authorization" \
     --data-urlencode client_id=agent-cli \
     --data-urlencode resource=https://<host> \
     --data-urlencode scope=read:project=p-1 \
     --data-urlencode agent_label='Release notes agent'
   ```

   It answers `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in` and
   `interval`. Show the person `verification_uri_complete`, or `verification_uri` and `user_code`. `invalid_target`
   means the host is no application resource (no group of its approved contract lists `agent`), `invalid_scope` a
   scope the client cannot ask for or a dimension the environment does not declare, and 429 with `retry-after` too many
   starts.

3. **The token poll.** Every `interval` seconds, until the person decides or `expires_in` passes:

   ```bash
   curl -sS "$ISSUER/oauth/token" \
     --data-urlencode grant_type=urn:ietf:params:oauth:grant-type:device_code \
     --data-urlencode client_id=agent-cli \
     --data-urlencode device_code="$DEVICE_CODE" \
     --data-urlencode resource=https://<host>
   ```

   `authorization_pending` means poll again, `slow_down` poll less often, `access_denied` the person refused,
   `expired_token` the code expired. Success answers `access_token`, `token_type: "Bearer"`, `expires_in`, `scope` (the
   scope the person approved) and `refresh_token`. The device code is spent by that answer.

4. **The refresh.** Before the access token expires:

   ```bash
   curl -sS "$ISSUER/oauth/token" \
     --data-urlencode grant_type=refresh_token \
     --data-urlencode client_id=agent-cli \
     --data-urlencode refresh_token="$REFRESH_TOKEN" \
     --data-urlencode resource=https://<host>
   ```

   It answers a new access token and a new `refresh_token`; keep the new one at once. A second use of a spent refresh
   token revokes the grant, and `invalid_grant` means the grant has ended.

5. **The revocation** (RFC 7009) of the access token or the refresh token revokes the whole grant, and answers 200 also
   for a token it does not know:

   ```bash
   curl -sS "$ISSUER/oauth/revoke" \
     --data-urlencode client_id=agent-cli \
     --data-urlencode token="$REFRESH_TOKEN" \
     --data-urlencode token_type_hint=refresh_token
   ```

The agent presents the access token as a bearer to the application, `Authorization: Bearer <token>`. The proxy verifies
it, exchanges it at IAM for the person's own application token, and calls the procedure with that: the application
sees the person (`ctx.principal`) and the agent (`ctx.agent`). At each exchange IAM reads the person's live permissions
and narrows them to the grant's value: a global grant becomes the same action at the value, a grant at the value stays,
and everything else is dropped, a grant at a container of the value included. So a grant narrowed to project A reaches
what the person's grants at A reach and nothing at project B, apart from what the application itself declares to cross
values (a member reveal, a `readThrough` or `writeThrough` path, a member-bound access view, `unscoped` or `sql`, a job
the request kicks, which runs with its own workload authority, and a `connect` import).

## Ending a grant

A grant is bound to the IAM session that approved it, and IAM mints nothing for it once that session has ended. Signing
out ends it. So does an administrator revoking the session, or the person losing their access. The token can also be
revoked at IAM's revocation endpoint (RFC 7009), which revokes the whole grant. The person lists every grant that acts
as them, the command-line client's and each agent's, on IAM's account page (`<issuer>/auth/account`), grouped by the
application each reaches with when it was allowed, when it last renewed its access and when it ends, and revokes any of
them there after a confirmation; an administrator does the same from the user's page in the console. A revoked grant refuses its next
refresh, and an agent's next exchange, so an issued access token stops working within 300 s.
