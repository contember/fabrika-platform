# Review widget on stage and dev

A person who tests an application on a stage or dev host comments on the page itself. Each comment is tied to their
identity, the page and the commit the environment served. The authoring agent reads and answers the comments over MCP.

**Size:** M (Cloudflare and Control), plus S–M for the Caddy half on Zerops.
**Depends on:** nothing hard. [Agent task keys](./agent-task-keys.md) makes an agent's reply carry "agent for person".
**Enables:** a fix loop driven by stakeholders' comments rather than chat screenshots;
[operations tools in the authoring MCP](./operations-tools-in-the-authoring-mcp.md) gives the same agent the runtime
errors of the same commit.

## Problem

Stakeholders test a stage application and report in chat, with screenshots. The agent that builds the application never
sees the report in a structured form: no page, no element, no commit. Someone retypes it.

agent-canvas already has a review widget that anchors a thread to an element and hands it to an agent. Its remote form
(the share worker in `packages/canvas-share`) authenticates a reviewer by a link key, keeps threads sealed outside the
installation, and knows no person and no commit. Inside an installation the person is known (IAM), the served commit is
known (Control), and the proxy fronts every stage and dev host. Nothing connects them.

## Design

### What exists

- **The widget.** `packages/agent-canvas/daemon/review-widget/` anchors a thread to an element: CSS path, role and
  name, text, landmarks, trimmed markup and style, an optional text quote and screenshot (`reviewAnchorSchema`,
  `packages/agent-canvas/daemon/src/review/model.ts:42`). Its store is pluggable: `ReviewClient`
  (`review-widget/client.ts:35`) has a daemon and a remote implementation (`remote-client.ts:19`). The thread states
  and transitions are `agent-canvas/review/threads`, already imported by `canvas-share/src/review.ts`. The local
  daemon injects the widget's tag before `</body>` (`withWidget`, `daemon/src/review/proxy.ts:36`).
- **The remote store** is one `ReviewProject` Durable Object per project (`canvas-share/src/review.ts:129`), with
  sealed bodies the object cannot read and access by link key and agent token (header of the same file).
- **The Cloudflare proxy Worker** handles every request of an application host in TypeScript and already rewrites the
  answer's headers (`packages/provider-cloudflare/src/proxy-worker.ts:205` fetches the application, `:229` builds the
  header treatment). `HTMLRewriter` is available there.
- **The Zerops proxy** is a stock Caddy 2.10.2 built with `go install` (`packages/provider-zerops/src/installation/topology/setups.ts:413`)
  in front of the Bun decision service. Stock Caddy has no streaming body rewrite. Its `templates` handler would
  evaluate the application's HTML as a Go template, so a `{{` in a page would execute. It is not an option.
- **The header policy** is the proxy's, not the application's: `headerPolicy` (`packages/proxy-core/src/headers.ts:113`)
  sets `script-src 'self'` plus the contract's origins, and the entry's `operationsOrigin` in `connect-src`
  (`manifest.ts:60`). A manifest field the producer adds is the precedent for a platform origin in the CSP.
- **Control's console table** already has `protocol` rows the service authenticates itself (`builder-connect`,
  `dev-source`; `packages/control/fabrika.service.ts:43-47`) and the authoring MCP tools
  (`packages/control/src/mcp/handler.ts:217-405`).
- **Environments.** An environment is `standard` or `dev` (`packages/control-contract/src/index.ts:213`); a standard one
  carries `authoring` and `protected` (`:228`, `:230`). A dev environment is never protected and never production.

### The shape

1. **Control owns the threads.** A thread lives in Control's database beside the workspace and run it refers to. It is
   not sent to the share worker: the installation already has the identity, and an installation's review data should
   not leave it. The share worker stays the path for applications outside an installation.
2. **An environment opts in.** A new registry field `review: boolean` on an application environment. Control refuses
   it on a `protected` environment, and sets it on a `dev` environment by default. Turning `protected` on clears it.
3. **The proxy injects one tag.** For an entry the manifest marks `review`, on an answer to a navigation
   (`Sec-Fetch-Mode: navigate`) that carried a session, with status 200 and `Content-Type: text/html`, the proxy adds
   `<script src="https://<console>/review/widget.js" defer></script>` before `</body>` (or at the end), and adds the
   console origin to `script-src` and `connect-src`. Nothing else of the body changes. A download endpoint, any other
   type, a non-navigation and an error page are untouched.
4. **The widget signs in through the console.** On first use (a click, so a popup is allowed) the widget opens
   `https://<console>/review/sign-in?origin=<page origin>` in a popup. The console page runs on the console's own
   session (one session per host, ADR-0023; a reviewer signed in to IAM passes without a prompt). Control checks that
   the origin is a host of a `review` environment and that the person holds `review.write` there, then posts a
   short-lived **review ticket** to `window.opener` with `targetOrigin` set to that exact origin, and closes. The
   ticket names the person, the application environment, the host and an expiry (1 hour), signed by a key in Control's
   vault.
5. **The widget talks to Control directly.** `ControlReviewClient`, a third `ReviewClient`, calls
   `https://<console>/review/api/*` with `Authorization: Bearer <ticket>` and no cookies. The row is a `protocol` row
   on the console table, like `builder-connect`: the proxy reads no credential there and Control verifies the ticket.
   Control answers CORS for that prefix with `Access-Control-Allow-Origin: *` and no credentials; it reads no `Origin`
   to decide anything.
6. **Each thread is stamped by Control.** On create, Control records the environment, the page URL from the anchor,
   the person, and what the environment served at that moment: the last succeeded run's commit on a standard
   environment, the sandbox's served head and its workspace on a dev environment (`packages/control/src/dev/`). The
   widget sends no commit; it could not know one.
7. **The agent works the threads over MCP.** New authoring tools read and answer threads of a target or a workspace.
   A reply records its author as the MCP principal; resolving a thread on a later commit stores that commit.

### Assumed, not confirmed

- That `caddyserver/replace-response` (a separate module, not in the stock build) streams a `text/html` body and can
  be limited to one host's navigations. Its behaviour against a compressed upstream answer is unchecked; the Caddy
  slice measures it in a running Caddy first.
- That a popup opened from an application host keeps `window.opener` across the console's IAM bounce. It does not
  when the application answer carries `Cross-Origin-Opener-Policy: same-origin`, which the proxy sets
  (`headers.ts:136`): a cross-origin popup loses its opener. The fallback is a redirect from the console back to a
  fixed fragment URL on the application host (`#fabrika-review-ticket=…`); the widget in that window reads the ticket
  and passes it to its same-origin opener. A fragment never reaches a server. Check both paths in a browser before
  choosing one.

## API and contract changes

**Registry.** `review: boolean` on `AppEnvDto` and its update request. A Control migration adds the column (default
`false`, `true` for `kind = 'dev'`).

**Proxy manifest.** `ContractProxyApp` gains `review?: { consoleOrigin: string }`, an exact `https` origin, refused by
the parser on an installation entry. Producers set it only for an environment with `review: true`:
`packages/provider-zerops/src/namespace/manifest.ts:27` (dev sandbox entries) and `:56`, and
`packages/provider-cloudflare/src/proxy.ts:151`. Older proxies' strict parsers refuse the key, so the Zerops producer
sends it only to a pin whose proxy setup declares a new marker `FABRIKA_PROXY_MANIFEST_REVIEW`
(`proxy-manifest-carrier.ts`, like `FABRIKA_PROXY_MANIFEST_BRAND` at `:35`).

**Header policy.** `appHeaderPolicy` adds the console origin to `script-src` and `connect-src` for an entry with
`review`. This is one more named origin, like `operationsOrigin`.

**Control's console table** gains `review-sign-in` (`GET /review/sign-in`, `human`), `review-widget`
(`GET /review/widget.js`, anonymous, cacheable) and `review-api` (`protocol`, `* /review/api/*`).

**Review API** (all under the ticket, all scoped to the ticket's environment):

| Method and path                        | What it does                                              |
| -------------------------------------- | --------------------------------------------------------- |
| `GET /review/api/threads?url=`         | Threads of the page, or of the environment without `url`. |
| `POST /review/api/threads`             | Create: anchor, body, optional screenshot (PNG, ≤ 2 MB).  |
| `POST /review/api/threads/:id/comment` | Add a comment.                                            |
| `POST /review/api/threads/:id/resolve` | Resolve or reopen.                                        |

**Storage.** `review_threads(id uuidv7, app_id, env, workspace_id null, commit_sha, page_url, anchor_json, state,
author_principal_id, screenshot_key null, created_at, updated_at, resolved_commit_sha null)` and
`review_comments(id, thread_id, author_principal_id, author_kind 'person'|'agent', body, created_at)`. The anchor is
`reviewAnchorSchema`, parsed once at the API boundary. Screenshots go to Control's `BlobStore`
(`packages/platform/src/ports.ts:13`). Deleting an environment or a workspace deletes its threads.

**Actions.** `review.read` and `review.write` in Control's vocabulary (`packages/control-contract/src/access.ts`), at
app/environment coordinates; a console preset `reviewer` grants `review.write` and `review.read`.

**MCP tools** (Control's `/mcp`, `readOnlyHint` on the reads):

- `list_feedback { target | workspaceId, state?, since? }` — threads with anchor, page, commit, author and comments.
- `get_feedback { threadId }` — one thread, the screenshot as an image content block.
- `reply_feedback { threadId, body, resolve? }` — an agent comment; `resolve` stores the workspace head as the
  resolving commit.
- `get_workspace` names the count of open threads on the workspace's commits.

**App↔platform protocol (ADR-0062).** Untouched. The application sees no new header, variable or row; the tag is added
by the proxy to an answer the application already wrote. An application of any framework release gets the widget.

## Security and permissions

- **Injection is presentation, not enforcement.** The proxy decides nothing new: the request has already passed the
  one decision (ADR-0022) when the answer is rewritten. Every read and write of a thread is authorized by Control
  against the ticket and the person's live `review.*` grants; the widget's presence grants nothing.
- **Who sees it.** Every session on a `review` host gets the tag. The widget shows its button only after Control
  answers that the person may review; a person without `review.write` sees nothing after one failed sign-in check.
- **Never production.** `review` cannot be set on a protected environment; the manifest field is written from the
  registry at publish time, so clearing it removes the tag at the next republish (Zerops) or deploy (Cloudflare).
- **CSP.** Only the console origin is added, and only to `script-src` and `connect-src`. No `unsafe-eval`, no inline
  script. The widget's styles stay in its shadow root; `style-src 'unsafe-inline'` is already in the policy.
- **XSS.** The widget renders comment bodies as text (the existing widget renders Markdown to DOM nodes, never
  `innerHTML` of user input; to be re-checked in review). A comment is shown on the application's origin, so a
  rendering bug is an XSS on the stage application, with the reviewer's application session. The API refuses HTML in
  anchors beyond the trimmed `html` field, which the widget never renders as markup.
- **The ticket** is a bearer for one environment's review API only, 1 hour, not renewable without the popup. It is not
  a `px_` key, so the proxy never accepts it elsewhere. It sits in the widget's memory, never in storage.
- **Data in threads.** Screenshots and anchors can hold personal data from stage. They stay in the installation, are
  readable only with `review.read`, and are deleted with the environment. The MCP client ships them to its model,
  as `read_files` already ships code; the operator decides by granting `review.read` to the `authoring` scope.

## Rollout on an existing installation

1. **Generated files.** The Zerops namespace proxy setup changes (the Caddy build with the extra module, the new
   marker). `fabrika platform upgrade` rebuilds the platform; an existing namespace keeps its pinned proxy until
   `fabrika control namespaces update --namespace=<id> --proxy-source=current` re-pins it (ADR-0045). Until then
   Control does not send `review`, and the widget is simply absent there.
2. **Environment variables.** None new on applications. Control's ticket key is a vault secret Control creates on
   first use.
3. **Provider state.** Existing environments read `review = false` (standard) or `true` (dev) after the migration;
   nothing else changes. A Cloudflare environment gets the tag at its next deploy, because its proxy Worker is built
   per deploy.
4. **Floating pins.** The Caddy module must be pinned by version in the build line, as Caddy is; the Go toolchain
   already floats (`setups.ts:395-400`). Upgraded and fresh namespaces resolve the same module version.

## Test plan

- `proxy-core`: the manifest parser accepts `review` on a contract entry, refuses it on an installation entry and with
  a non-`https` origin; `appHeaderPolicy` adds the origin to exactly two directives.
- Cloudflare proxy Worker (`proxy-worker.test.ts`): the tag is added for a session navigation answered 200
  `text/html`, and not for a non-navigation, a download endpoint, a 4xx/5xx, another type, an anonymous request, or an
  entry without `review`; the body is otherwise byte-identical.
- Caddy (`caddy.live.test.ts`, with `FABRIKA_TEST_CADDY_BIN` built with the module): the same matrix in a running Caddy,
  plus a gzip upstream.
- Control: the ticket refuses another environment, an expired ticket, a person without `review.write` and a protected
  environment; the stamped commit is the run's or the sandbox's, never the client's; deleting an environment deletes
  its threads and screenshots.
- MCP: `list_feedback` and `reply_feedback` in the in-process MCP witness, with a principal lacking `review.read`
  refused.
- Browser: an opice suite in `tests/browser` on the local stack: sign in as a reviewer, comment on an element, read
  it through the MCP tool, reply, see the reply in the widget.

## Slicing into PRs

1. **Threads in Control, no widget (M).** Registry field, migration, actions, review API with tickets, MCP tools.
   Witness: Control tests and the MCP witness create and answer a thread through the API.
2. **The widget's Control client (S).** `ControlReviewClient` and the sign-in popup in agent-canvas's widget, served
   by Control at `/review/widget.js`. Witness: a widget browser test against a stub API.
3. **Manifest field and Cloudflare injection (S–M).** `review` in the manifest and header policy, the producer on
   Cloudflare, `HTMLRewriter` in the proxy Worker. Witness: the proxy Worker matrix above.
4. **Zerops injection (M).** Caddy with the response-rewrite module, the new marker, the Zerops producer. Witness:
   the Caddy live matrix; the namespace refuses nothing on an old pin and sends no `review`.
5. **End-to-end suite (S).** The opice suite on the local stack.

Slices 1 and 2 ship value on their own: a reviewer can open the widget through a bookmarklet the console prints, before
any proxy change.

## Open questions

1. **Where does the ticket hand-over land when COOP severs the opener?** Default: the fragment redirect described
   above; decide after the browser check in slice 2.
2. **Inject for every session, or only for people with `review.write`?** The proxy cannot know Control's grants.
   Default: every session on a `review` host; the widget stays hidden for others. Stage hosts are test hosts.
3. **Caddy module or a different Zerops path?** Default: `replace-response`, pinned. Fallback: slice 2's bookmarklet
   only, on Zerops, if the module fails the compression or streaming check.
4. **One store with the share worker?** Default: no. The threads model and anchor schema are shared through
   `agent-canvas/review/model`; storage and identity differ.
5. **Does this need an ADR?** Yes: a short one recording that review threads live in Control, that the proxy may
   rewrite an HTML answer as presentation only, and the ticket's place beside ADR-0022's credential rules.
