# Application–platform channels

A proposal in two steps:

1. **The platform call.** One binding way for an application to call an installation service: under its own
   principal, through the service's proxy, with a key per receiver that Control issues at deploy. It is the wire
   connectors already use, extended from application owners to installation services.
2. **The mail relay.** The first consumer. Control receives every installation mail into a table, gates it by rules
   per recipient domain (`pass`, `hold`, `drop`), and dispatches it through the provider. The application no longer
   holds the provider's credential, and a local stack is an installation that holds every message.

The state described is the `feat/declare-the-surface` branch (framework 0.6: `queue`/`claim`, `kicks`, `egress`, files
as values, public procedures).

## The problem

Each feature that lets an application reach the platform added its own transport, its own credential and its own
durability rule. Mail is the sharpest case: an application whose job declares `mailer: 'installation'` receives the
provider's credential (`installationMailEnvironment`, `packages/control/src/mail-transport.ts`) and sends directly. The
platform cannot queue, inspect, hold or drop that mail. A newly launched application cannot be held back while an
operator reads what it sends, and a local stack can only capture mail to a directory.

Audit is split. An application audits in its own tables, in the invocation's transaction: durable, but the platform
never sees it, so an operator cannot read one log of what IAM changed (membership, links, roles) and what the
application did with it. The platform services' own `IamRpc.audit` is fire-and-forget (`packages/iam/src/rpc.ts`,
backlog 71), and an application cannot call it. Operations ingest is unauthenticated (backlog 96).

## Inventory

### Channels a running application uses

| Channel        | Direction                  | Transport (Zerops / Cloudflare)                                   | Credential in the application                                           | Through the proxy                 | Sync / durability                       |
| -------------- | -------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------- | --------------------------------------- |
| JWKS           | app → IAM                  | `GET <issuer>/.well-known/jwks.json` / `IAM` binding              | none                                                                    | yes, anonymous row                | sync, cached                            |
| Request token  | proxy → app                | `X-Fabrika-Token`, `X-Fabrika-Delegation` headers                 | `FABRIKA_PROXY_SECRET` (Zerops)                                         | is the proxy                      | per request                             |
| Membership     | app → IAM                  | `POST <issuer>/membership/<method>` / `IAM` binding               | `FABRIKA_IAM_RPC_KEY` per `<app>@<env>` (Zerops)                        | `protocol` row, IAM authenticates | sync, 5 s, no retry, no idempotency key |
| Workload token | job, webhook, public → IAM | `POST <issuer>/auth/workload/token` / not available               | `FABRIKA_JOB_*_KEY`, `FABRIKA_WEBHOOK_*_KEY`, `FABRIKA_PROCEDURE_*_KEY` | `auth` row, IAM authenticates     | sync, cached per token lifetime         |
| Connector      | app → app                  | `POST <owner>/__fabrika/connect/…` / binding to the owner's proxy | `FABRIKA_CONNECT_<IMPORT>_KEY` per edge, kind `app`                     | yes: `mintFromKey`, `app:<id>`    | sync, ≤ 10 s, 2 retries, read-only      |
| Error ingest   | app, browser → Operations  | Sentry envelope over `fetch`                                      | `FABRIKA_OPERATIONS_DSN` (public key)                                   | `protocol` row, Operations checks | fire-and-forget, 5 s, no retry          |
| Mail           | app → provider             | provider HTTP API / not available                                 | the installation's provider credential                                  | no                                | sync within a job attempt               |
| Files          | app → object storage       | S3 API / not available                                            | `FABRIKA_APP_STORAGE_*`                                                 | no                                | sync, staged until a column holds it    |
| Signed tokens  | app only                   | HMAC, no I/O / refused                                            | `FABRIKA_TOKEN_KEYS`                                                    | —                                 | stateless                               |
| Audit          | —                          | none for applications                                             | —                                                                       | —                                 | —                                       |

Out of scope: the proxy's own `/auth/mint/*`, Control's `/rpc/*` and schema reconcile, source-map upload, and
Control → Operations release sync. They are installation-internal or build-time.

### What a handler receives that the platform backs

| Member                      | RPC      | Public   | Link     | Export | Job  | Webhook | Backed by                                    | Rolls back with the transaction | Unlocked by               |
| --------------------------- | -------- | -------- | -------- | ------ | ---- | ------- | -------------------------------------------- | ------------------------------- | ------------------------- |
| capabilities                | yes      | `app`    | target   | yes    | yes  | `refs`  | the token's grants, minted locally           | —                               | `access`, `actions`       |
| `created` (`creates`)       | yes      | —        | —        | —      | —    | —       | IAM `createScope`, before the handler        | no                              | `access: { creates }`     |
| `ctx.members`               | yes      | —        | —        | —      | —    | —       | IAM membership transport                     | no                              | the dimension's `members` |
| `ctx.links`                 | yes      | —        | —        | —      | yes  | —       | IAM membership transport                     | no                              | `issues`                  |
| `ctx.files` (`put`, `open`) | yes      | yes      | yes      | —      | yes  | yes     | object storage + `fabrika_files`             | a put is kept only if committed | a `c.files` kind          |
| `ctx.connect`               | yes      | —        | —        | —      | —    | —       | the owner application, through its proxy     | no                              | `connect`                 |
| `ctx.kick`                  | mutation | mutation | mutation | —      | yes  | yes     | the application's lease tables               | sent after commit               | `kicks`                   |
| `claim`                     | —        | —        | —        | —      | yes  | —       | the application's queue table                | its own transaction             | table policy `queue`      |
| `fetch`                     | yes      | —        | —        | —      | yes  | yes     | the outside world, guarded                   | no                              | `egress`                  |
| `ctx.mail`                  | —        | —        | —        | —      | yes  | —       | the provider, with the installation's secret | no                              | `mailer`                  |
| `ctx.tokens.sign`           | yes      | yes      | —        | —      | yes  | yes     | `FABRIKA_TOKEN_KEYS`                         | —                               | `signs`                   |
| failure reports             | auto     | auto     | auto     | auto   | auto | auto    | Operations ingest                            | —                               | —                         |

On Cloudflare a deploy refuses every workload key, `FABRIKA_EMAIL_*` and `FABRIKA_TOKEN_KEYS`
(`packages/provider-cloudflare/src/control.ts`), and a Worker has no data layer: an application there has
endpoints, IAM and connectors only.

### Findings

1. **The connector wire is the one that generalizes.** It is the only channel where the application holds a key of a
   principal kind, the proxy exchanges it at IAM (`exchangeKey`, `packages/proxy-core/src/authorize.ts`) and the
   endpoint table decides (ADR-0022). Membership and workload tokens are `protocol` rows that their service
   authenticates itself.
2. **Durability on the application side is solved.** `queue`/`claim` and `ctx.kick` (ADR-0060) are the outbox recipe
   on the road. A platform channel needs no outbox of its own; it needs a receiver that is idempotent per key.
3. **Mail is the only member that hands a platform secret to the application.** Every other platform-backed member
   works with a credential scoped to the application.
4. **The framework already separates platform calls from the site's.** `platformCall` and `platformFacility`
   (`packages/app/src/implement/egress.ts`) run IAM, connectors and mail outside the site's `egress`. A platform call
   is one more facility there.
5. **An application cannot report anything on purpose.** Operations receives a 5xx, a failed job run and a crash only.
   A handled error, a business event and a job's success have no member (backlog 96).
6. **Audit stays local.** A platform audit member would be a platform call to IAM's log under a stable event id
   (backlog 71's requirement), drained from the application's queue.

## Decisions taken

- **A transport key per receiver, verified by the receiver.** The pattern of the membership transport
  (`packages/iam/src/membership-http.ts`): a `protocol` row the receiver authenticates itself, a key pinned to one
  `<app>@<env>`, stored as a hash, issued and rotated by Control. An `app` workload key at IAM was rejected: Control's
  IAM schema is static, and its reconcile replaces the whole vocabulary, so per-application workloads would be revoked
  on every platform upgrade.
- **Older framework releases keep the direct credential.** A release inside the ADR-0062 window that does not know the
  relay receives `FABRIKA_EMAIL_*` with the provider's credential, as today. The gate does not cover it until the
  release leaves the window, and the console says so per application environment.
- **IAM and Operations send through the relay, always `pass`.** Their mail is recorded and dispatched at once;
  `hold` and `drop` rules never apply to it. Operations' alert delivery (backlog 46) uses the relay instead of a
  dispatcher of its own.
- **Control owns the relay.** It already holds the installation's transport, the console and the deploy that hands
  the application its variables.
- **Zerops only.** On Cloudflare nothing changes: IAM keeps sending directly, and applications there send no mail.

## Step 1 — the platform call

A synchronous request from an application to an installation service.

- **Wire.** `POST <receiver URL>/<method>` with `Authorization: Bearer <transport key>`, through the receiver's proxy
  as a `protocol` row; the receiver resolves the key to the application environment it is pinned to.
- **Rows.** The receiver serves one `protocol` row per transport. The proxy passes it through; nothing in the
  proxy, `callerAdmittedAt` or IAM changes. The receiver authorizes on the key's application environment, never on a
  body field.
- **Keys and variables.** Control issues the key at deploy, keeps its hash, seals and rotates it like the membership
  transport key, and writes
  `FABRIKA_PLATFORM_<RECEIVER>_URL` and `FABRIKA_PLATFORM_<RECEIVER>_KEY`. A new framework-variable family, so no
  application sets it, the scrubber removes it, and an older release that does not read it is unaffected.
- **Which receivers.** Control derives them from the approved artifact: a job with `mailer: 'installation'` uses the
  mail receiver. Nothing new is declared; the approval shows what it shows today.
- **Idempotency.** Every receiver records the caller's key and the message's fingerprint before it answers, and
  answers a repeat with the first result. With that, the caller's retry rule is `mayRetryDelivery` over
  `idempotent: true`, whatever the receiver does downstream.
- **Framework side.** One facility (`platformFacility`) per receiver, outside the site's `egress`, with the deadline
  and the answer validation of a connector call.
- **Zerops only.** Cloudflare runs no job, so nothing there calls a receiver yet.

The ADR records the wire, the admission rule, the variable family and the idempotency contract. Membership, audit and
job reports may move onto it later; each is its own decision.

## Step 2 — the mail relay

### The application side

- A new release reads `FABRIKA_EMAIL_PROVIDER=platform` and builds its `EmailSender` over the platform call to the mail
  receiver. `ctx.mail` keeps its API: `send`, `available`, `capabilities`, `mayRetry`.
- The relay answers `capabilities: { idempotent: true, confirmation: 'queued' }`. `send` means "the platform took
  it", not "the provider took it".
- Durability stays the application's: a queue table, `ctx.kick`, `claim` in the mailer job. An endpoint still sends no
  mail.
- The `mailKeyPrefix` stays: it keeps applications on one provider account apart, and the relay keys its table on it.

### The platform side, in Control

- **Every message is a row**, with or without a provider: recipient, subject, bodies, attachments, the caller's
  application environment, key, fingerprint, the rule that decided it, state, the provider's outcome.
- **The gate.** Rules per installation and application environment, by recipient domain: `pass`, `hold`, `drop`. A
  default per application environment (a new one starts on `hold`, for example). `drop` records the row and sends
  nothing; the application's `send` still answers accepted. An operator approves or drops held rows in the console.
- **The dispatcher** sends released rows through the installation's `EmailSender` under the row's key, and records
  the outcome. Over a non-idempotent provider an `unknown` outcome stays for a person, as today.
- **Without a provider** every row stays held. A local stack is that installation: the console replaces the directory
  capture and the dev mail view.
- **IAM** sends through the same table with `pass`, over a private hop to Control (Zerops). Its rows keep no body once
  dispatched, because a body carries a one-time link.
- **Bodies are secrets.** Reading a held body is a permission of its own, and every body has a retention.

### Rollout of an existing installation

- `FABRIKA_EMAIL_*` on `iam` and `control` stays the installation's transport; Control now dispatches with it, and
  IAM's copy is no longer used once IAM sends through the relay.
- An application environment converges at its next deploy: a release that knows `platform` gets the platform
  variables and loses the provider's credential; an older release keeps it (decision above).
- Existing installations have no rules. The default is `pass` for every application environment, so nothing changes
  until an operator adds a `hold`.

## Open questions

1. **`drop` and ADR-0019**, which says a missing sender never silently drops a message. A dropped row is recorded and
   visible; the ADR must say so.
2. **IAM's `unknown`.** IAM keeps an invitation open after an `unknown` outcome. Over the relay, an answer is
   `queued` and idempotent, so `unknown` means only that the relay was unreachable.
3. **Backlog 178** (an HTTP relay protocol and a relay adapter) becomes this proposal's wire and is rewritten or
   deleted.
