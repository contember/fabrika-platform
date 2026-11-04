# Review widget on stage and dev

A person who tests an application on a stage or dev host comments on the page itself. Each comment is tied to their
identity, the page and the commit the environment served. The authoring agent reads and answers the comments over MCP.

**Size:** M (Control and the widget), plus S–M per provider's injection. Zerops is built first if its check passes
("Decisions").
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
   it on a `protected` environment and on the canonical `prod` environment (ADR-0024), and sets it on a `dev`
   environment by default. Turning `protected` on clears it.
3. **The proxy injects one tag.** For an entry the manifest marks `review`, on an answer to a navigation
   (`Sec-Fetch-Mode: navigate`) that carried a session, with status 200 and `Content-Type: text/html`, the proxy adds
   `<script src="https://<console>/review/widget.js" data-served="<run or none>" defer></script>` before `</body>` (or
   at the end). The policy admits exactly that script URL in `script-src` and the `https://<console>/review/api/`
   prefix in `connect-src`, not the whole console origin. Nothing else of the body changes. A download endpoint, any
   other type, a non-navigation and an error page are untouched.
4. **The widget signs in through the console.** On first use (a click, so a popup is allowed) the widget opens
   `https://<console>/review/sign-in?origin=<page origin>` in a popup. The console page runs on the console's own
   session (one session per host, ADR-0023; a reviewer signed in to IAM passes without a prompt). Control reads the
   person's live grants from the token the proxy injects on that `human` row, checks that the origin is a host of a
   `review` environment and that the person holds `review.write` there, then hands a short-lived **review ticket** to
   the page (see "Assumed" for how) and closes. The ticket names the person, the application environment, the host and
   an expiry of 10 minutes, signed by a key in Control's vault.
5. **The widget talks to Control directly.** `ControlReviewClient`, a third `ReviewClient`, calls
   `https://<console>/review/api/*` with `Authorization: Bearer <ticket>` and no cookies. The row is a `protocol` row
   on the console table, like `builder-connect`: the proxy reads no credential there and Control verifies the ticket.
   Control answers CORS for that prefix with `Access-Control-Allow-Origin: *` and no credentials; it reads no `Origin`
   to decide anything. On that row Control sees no IAM token, so it cannot re-read the person's grants per request: a
   revoked `review.write` keeps working until the ticket expires, at most 10 minutes. That lag is the price of the
   `protocol` row; the alternative (Control asking IAM per request) needs an `IamRpc` call that resolves a principal's
   grants without a session, which does not exist (`packages/auth-core/src/rpc.ts:293-329`).
6. **Provenance is bound where it can be.** On Cloudflare a standard environment's proxy Worker is built per run, so
   the manifest's `review` field carries that run's id and the tag carries it as `data-served`; the widget sends it
   back and Control records that run's commit. Where the proxy outlives the run (a Zerops namespace proxy, whose
   rebuild a changed manifest would force on every deploy, and every dev sandbox, whose head moves without a run),
   the tag carries none, and Control records the commit served at comment time (`getLatestSucceededRun`,
   `packages/control/src/db/runs.ts:144`, or the sandbox's reported head) with `provenance: 'at_comment'` and the time
   that commit started serving. A thread whose comment came within that commit's first minutes is marked `ambiguous`.
   The MCP tools show the provenance; the agent never reads an `at_comment` commit as certain. A `data-served` value is
   accepted only when it names a run of the ticket's environment.
7. **The agent works the threads over MCP.** New authoring tools read and answer threads of a target or a workspace.
   A reply records its author as the MCP principal; resolving a thread on a later commit stores that commit.

### Assumed, not confirmed

- That `caddyserver/replace-response` (a separate module, not in the stock build) streams a `text/html` body and can
  be limited to one host's navigations. Its behaviour against a compressed upstream answer is unchecked. This is the
  first thing checked, in a running Caddy built as the Zerops proxy is, before any slice; it decides the order of the
  injection slices ("Decisions").
- **The ticket hand-over cannot use `window.opener`.** The proxy sets `Cross-Origin-Opener-Policy: same-origin` on
  every application answer (`packages/proxy-core/src/headers.ts:136`). A popup that navigates to the console origin
  is moved to another browsing context group, and its opener stays null even after it returns to the application
  origin. So the console redirects the popup to a fixed fragment URL on the application host
  (`#fabrika-review-ticket=…`); the widget in that window reads the ticket from the fragment and posts it on a
  `BroadcastChannel` named by a nonce the opening widget chose, then closes. `BroadcastChannel` reaches same-origin
  pages of one storage partition without the opener, and keeps the ticket out of storage. A fragment never reaches a
  server. The browser check confirms the hand-over in Chromium and Firefox under the proxy's COOP before slice 2.

## API and contract changes

**Registry.** `review: boolean` on `AppEnvDto` and its update request. A Control migration adds the column (default
`false`, `true` for `kind = 'dev'`).

**Proxy manifest.** `ContractProxyApp` gains `review?: { consoleOrigin: string; servedRun?: string }`: an exact `https`
origin and, on Cloudflare only, the run id the Worker was built for. The parser refuses it on an installation entry. Producers set it only for an environment with `review: true`:
`packages/provider-zerops/src/namespace/manifest.ts:27` (dev sandbox entries) and `:56`, and
`packages/provider-cloudflare/src/proxy.ts:151`. Older proxies' strict parsers refuse the key, so the Zerops producer
sends it only to a pin whose proxy setup declares a new marker `FABRIKA_PROXY_MANIFEST_REVIEW`
(`proxy-manifest-carrier.ts`, like `FABRIKA_PROXY_MANIFEST_BRAND` at `:35`).

**Header policy.** `appHeaderPolicy` adds `https://<console>/review/widget.js` to `script-src` and
`https://<console>/review/api/` to `connect-src` for an entry with `review`. CSP path sources admit exactly those; the
widget ships as one file, so no chunk needs a wider source. This is one more named source, like `operationsOrigin`.
Today's policy admits neither (`packages/proxy-core/src/headers.ts:114-118`), so no widget can run on a proxied
application before this change.

**Control's console table** gains `review-sign-in` (`GET /review/sign-in`, `human`), `review-widget`
(`GET /review/widget.js`, anonymous, cacheable) and `review-api` (`protocol`, `* /review/api/*`). The table's digest
changes, so `controlMcpSwitch` (`packages/control/fabrika.service.ts:81`) at the new release refuses the old
`FABRIKA_SERVICE_TABLE_DIGEST`; see the rollout.

**Review API** (all under the ticket, all scoped to the ticket's environment):

| Method and path                        | What it does                                              |
| -------------------------------------- | --------------------------------------------------------- |
| `GET /review/api/threads?url=`         | Threads of the page, or of the environment without `url`. |
| `POST /review/api/threads`             | Create: anchor, body, optional screenshot (PNG, ≤ 2 MB).  |
| `POST /review/api/threads/:id/comment` | Add a comment.                                            |

A ticket cannot resolve, reopen or delete a thread; the reviewer does that in the console, and the agent over MCP. The
API is rate-limited per ticket (30 writes a minute).

**Storage.** `review_threads(id uuidv7, app_id, env, workspace_id null, commit_sha, provenance 'served'|'at_comment',
ambiguous, page_url, anchor_json, state, author_principal_id, screenshot_key null, created_at, updated_at,
resolved_commit_sha null)` and
`review_comments(id, thread_id, author_principal_id, author_kind 'person'|'agent', body, created_at)`. The anchor is
`reviewAnchorSchema`, parsed once at the API boundary. Screenshots go to Control's `BlobStore`
(`packages/platform/src/ports.ts:13`). Deleting an environment or a workspace deletes its threads.

**Actions.** `review.read` and `review.write` in Control's vocabulary (`packages/control-contract/src/access.ts`), at
app/environment coordinates; a console preset `reviewer` grants `review.write` and `review.read`.

**Reviewers are internal.** An external principal may hold only a role its application declares external
(`packages/iam/src/contract-rules.ts:60-80`, ADR-0051), and the console declares none, so an external person cannot
hold `reviewer`. Default for this spec: reviewers are internal principals. Admitting an external stakeholder needs a
console role declared external and scoped to one application environment; that is a follow-up with its own ADR-0051
change, not part of these slices.

**MCP scope.** The console's MCP resource gets one scope per feature: `authoring` stays as it is, and a new `review`
scope carries `review.read` and `review.write`. The ceiling is code, in the console's OAuth resource template
(`packages/platform-artifacts/src/proxy-manifest.ts:59-72`), not operator configuration. A grant made before the
release gains nothing: IAM recomputes a scope's ceiling at refresh (`packages/iam/src/oauth.ts:232`), and the client
must ask for `review`. A task key ([agent task keys](./agent-task-keys.md)) picks its scopes, so a reply made under a
task carries `act`.

**MCP tools** (Control's `/mcp`, scope `review`, `readOnlyHint` on the reads):

- `list_feedback { target | workspaceId, state?, since? }` — threads with anchor, page, commit and its provenance,
  author and comments.
- `get_feedback { threadId }` — one thread, the screenshot as an image content block.
- `reply_feedback { threadId, body, resolve? }` — an agent comment; `resolve` stores the workspace head as the
  resolving commit.
- `get_workspace` names the count of open threads on the workspace's commits. The field is left out when the token
  lacks the `review` scope.

**App↔platform protocol (ADR-0062).** Untouched. The application sees no new header, variable or row; the tag is added
by the proxy to an answer the application already wrote. An application of any framework release gets the widget.

## Security and permissions

- **Injection is presentation, not enforcement.** The proxy decides nothing new: the request has already passed the
  one decision (ADR-0022) when the answer is rewritten. The ticket is issued on live grants (the sign-in row) and
  every API call is authorized by Control against the ticket; grants revoked meanwhile apply within the ticket's
  10 minutes. The widget's presence grants nothing.
- **Who sees it.** Every session on a `review` host gets the tag. The widget shows its button only after Control
  answers that the person may review; a person without `review.write` sees nothing after one failed sign-in check.
- **"Never production" means "never protected, never `prod`".** Control has no other production marker: `prod` is
  protected by default and an operator can unprotect it, so `review` is refused on the name as well as on the flag.
  The manifest field is written from the registry at publish time, so clearing it removes the tag at the next
  republish (Zerops) or deploy (Cloudflare).
- **CSP.** Only the widget's URL is added to `script-src` and only the API prefix to `connect-src`. No `unsafe-eval`, no
  inline script. The widget's styles stay in its shadow root; `style-src 'unsafe-inline'` is already in the policy.
- **The application origin can read the ticket.** The widget runs in the application's page, so the application's own
  script can read the ticket from the widget's memory. In a dev sandbox that script is unreviewed agent code. The ticket
  is therefore narrowed to what the reviewer could do by hand on that page anyway: read the environment's threads and
  create threads and comments as that person, for 10 minutes, rate-limited, and nothing else (no resolve, no delete, no
  other environment, no console API). Screenshots of other reviewers' threads are served to a ticket only as the
  widget's thumbnails, never the stored original.
- **XSS.** The widget renders comment bodies as text (the existing widget renders Markdown to DOM nodes, never
  `innerHTML` of user input; to be re-checked in review). A comment is shown on the application's origin, so a
  rendering bug is an XSS on the stage application, with the reviewer's application session. The API refuses HTML in
  anchors beyond the trimmed `html` field, which the widget never renders as markup.
- **The ticket** is a bearer for one environment's review API only, 10 minutes, not renewable without the popup. It is
  not a `px_` key, so the proxy never accepts it elsewhere. It sits in the widget's memory, never in storage.
- **Data in threads.** Screenshots and anchors can hold personal data from stage. They stay in the installation, are
  readable only with `review.read`, and are deleted with the environment. The MCP client ships them to its model,
  as `read_files` already ships code. Only a client that asks for the separate `review` scope receives them; an
  `authoring` grant never does.

## Rollout on an existing installation

1. **Generated files.** The Zerops namespace proxy setup changes (the Caddy build with the extra module, the new
   marker). `fabrika platform upgrade` rebuilds the platform; an existing namespace keeps its pinned proxy until
   `fabrika control namespaces update --namespace=<id> --proxy-source=current` re-pins it (ADR-0045). Until then
   Control does not send `review`, and the widget is simply absent there. The console's service table changes too:
   the platform proxy's manifest template is regenerated (`platform-artifacts` `gen`), and the
   `FABRIKA_SERVICE_TABLE_DIGEST` the composition writes changes with it. Control at the new release refuses the old
   digest at boot (`controlMcpSwitch`), so Control and the platform proxy upgrade together. `platform upgrade` already
   does: on Zerops `platform deploy` builds the proxy before Control and writes the digest from the same manifest; on
   Cloudflare the console's proxy is built from the same table in Control's own deploy.
2. **Environment variables.** On Zerops, `FABRIKA_SERVICE_TABLE_DIGEST` is rewritten by every `platform deploy`. None
   new on applications. Control's ticket key is a vault secret Control creates on first use.
3. **Provider state.** Existing environments read `review = false` (standard) or `true` (dev) after the migration;
   nothing else changes. A Cloudflare environment gets the tag at its next deploy, because its proxy Worker is built
   per deploy.
4. **Floating pins.** The Caddy module must be pinned by version in the build line, as Caddy is; the Go toolchain
   already floats (`setups.ts:395-400`). Upgraded and fresh namespaces resolve the same module version.

## Test plan

- `proxy-core`: the manifest parser accepts `review` on a contract entry, refuses it on an installation entry and with
  a non-`https` origin; `appHeaderPolicy` adds the widget URL to `script-src` and the API prefix to `connect-src`, and
  nothing else.
- Cloudflare proxy Worker (`proxy-worker.test.ts`): the tag is added for a session navigation answered 200
  `text/html`, and not for a non-navigation, a download endpoint, a 4xx/5xx, another type, an anonymous request, or an
  entry without `review`; the body is otherwise byte-identical.
- Caddy (`caddy.live.test.ts`, with `FABRIKA_TEST_CADDY_BIN` built with the module): the same matrix in a running Caddy,
  plus a gzip upstream.
- Ticket hand-over: under the proxy's COOP, the popup's ticket reaches the opening widget through `BroadcastChannel`,
  in Chromium and Firefox; a page of another origin receives nothing.
- Control: the ticket refuses another environment, an expired ticket, a person without `review.write`, a protected
  environment and `prod`; a ticket cannot resolve or delete; `review` is refused on `prod` and on a protected
  environment, and cleared when `protected` is set.
- Provenance: on Cloudflare, a deploy between page load and comment records the loaded run's commit (`data-served`),
  not the newer one; a `data-served` naming another environment's run is refused. On Zerops and dev, the thread is
  `at_comment`, and `ambiguous` when the commit started serving shortly before.
- Deleting an environment deletes its threads and screenshots.
- MCP: `list_feedback` and `reply_feedback` in the in-process MCP witness, with a principal lacking `review.read`
  refused.
- Browser: an opice suite in `tests/browser` on the local stack: sign in as a reviewer, comment on an element, read
  it through the MCP tool, reply, see the reply in the widget.

## Slicing into PRs

0. **Verify first (no PR).** `replace-response` in a running Caddy 2.10.2 built as the Zerops proxy is: streaming, a
   gzip upstream, limited to one host's navigations. Its result picks the order of slices 2 and 3.
1. **Threads in Control, no widget (M).** Registry field, migration, actions, `review` MCP scope, review API with
   tickets, MCP tools, the console's new rows. Witness: Control tests and the MCP witness create and answer a thread
   through the API; the console lists it.
2. **The widget on Zerops (M).** `ControlReviewClient`, the sign-in popup and the `BroadcastChannel` hand-over in
   agent-canvas's widget, served by Control at `/review/widget.js`; `review` in the manifest and the header policy;
   Caddy with the response-rewrite module, the new marker, the Zerops producer for namespace and dev sandbox entries.
   This is the first slice a reviewer can use: the CSP admits no widget before it, and dev sandboxes are Zerops only.
   Witness: the Caddy live matrix; the namespace refuses nothing on an old pin and sends no `review`; a browser test on
   the local stack's apps proxy (Caddy) in front of an example application that loads the widget and posts a thread.
3. **Cloudflare injection (S–M).** The Cloudflare producer and `HTMLRewriter` in the proxy Worker. Witness: the proxy
   Worker matrix.
4. **End-to-end suite (S).** The opice suite on the local stack.

If the check in step 0 fails, slices 2 and 3 swap: the widget, the manifest field and the header policy land with
the Cloudflare injection, and Zerops gets no widget until another rewrite path is found (open question 3).

Slice 1 has no reviewer-facing value on its own: it is the store and the agent's side. No bookmarklet path exists
before slice 2, because the application's CSP refuses a script from the console.

## Open questions

1. **Inject for every session, or only for people with `review.write`?** The proxy cannot know Control's grants.
   Default: every session on a `review` host; the widget stays hidden for others. Stage hosts are test hosts.
2. **Caddy module or a different Zerops path?** Default: `replace-response`, pinned. If it fails the compression or
   streaming check, Zerops gets no widget until another rewrite path is found; there is no CSP-compatible fallback.
3. **External reviewers?** Default: internal only (above). Revisit with a console role declared external.
4. **Ticket lag versus a per-request grant check?** Default: 10-minute tickets. Shorten, or add an `IamRpc` grant read,
   if an operator needs revocation to bite at once.
5. **One store with the share worker?** Default: no. The threads model and anchor schema are shared through
   `agent-canvas/review/model`; storage and identity differ.
6. **Does this need an ADR?** Yes: a short one recording that review threads live in Control, that the proxy may
   rewrite an HTML answer as presentation only, and the ticket's place beside ADR-0022's credential rules.

## Decisions

- **Zerops first, if Caddy can do it** (review of 2026-11-04). The `replace-response` check runs before any slice. If
  it passes, the Zerops injection (slice 2) is built before the Cloudflare one (slice 3); if it fails, the order
  swaps and Zerops waits for another rewrite path.
- **The ticket reaches the widget through `BroadcastChannel`**, not `window.opener`, which the proxy's COOP severs.
