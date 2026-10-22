# Outbound email

`@fabrika/email` is the portable outbound-email boundary for Fabrika services.
It runs on both Cloudflare Workers and Bun. The package does not know about IAM,
Operations, templates, action tokens, notification targets, or retry schedules.
Its interface is public: an adapter outside this repository implements the same
`EmailSender` and passes the same conformance kit.

## Contract

An `EmailSender` accepts one message with these fields:

- one recipient address;
- subject and plain-text body;
- an optional HTML body;
- a caller-owned idempotency key (1 to 256 visible ASCII characters; a prefix the
  caller adds must fit inside it);
- an optional reply-to address;
- an optional sender display name, which replaces the transport's own for this
  message;
- an optional one-click unsubscribe URL (`unsubscribeUrl`, an exact `https:` URL): the transport writes
  `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058);
- optional attachments: at most 20 (`MAX_EMAIL_ATTACHMENTS`), each a name without a path separator or a quote, a
  media type and the bytes. An empty list is none;
- `broadcast`: the message is one of a send to many recipients (a newsletter, an announcement), not mail the
  recipient's own action triggered. It needs `unsubscribeUrl`. Providers keep broadcast mail apart from transactional
  mail, and one (Postmark) pauses a server whose transactional stream carries it.

The attachments, the unsubscribe URL and `broadcast` are part of the content a repeated idempotency key must match.

`send(message, signal)` takes the caller's `AbortSignal`. A successful call
returns an accepted result with a provider-neutral message ID.

Each sender reports its `capabilities`:

| field                         | meaning                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotent`                  | A repeated send under one key with the same message is not delivered again.                                                               |
| `confirmation`                | `sync`: accepted means the provider took the message. `queued`: it may still drop the request.                                            |
| `maxBatch`                    | The most messages one call carries. `send` carries one, so every built-in sender reports 1.                                               |
| `listUnsubscribe`             | Whether it writes the unsubscribe headers. Absent is no: it refuses a message with `unsubscribeUrl` as `invalid_message`.                 |
| `maxAttachmentBytes`          | The most attachment bytes of one message, every file together. Absent: it refuses a message with any attachment as `invalid_message`.     |
| `refusedAttachmentExtensions` | File extensions it refuses an attachment for, lowercase without the dot. Absent: none.                                                    |
| `minBodyLength`               | The fewest characters a text or HTML body has once trimmed. Absent: any body that is not blank.                                           |
| `broadcast`                   | Whether it sends a `broadcast` message, on its provider's channel for them where it has one. Absent: it refuses one as `invalid_message`. |

Failures use `EmailDeliveryError`. The adapter names a code; one table,
`EMAIL_DELIVERY_ERRORS`, derives `retryable` and `outcome` from it, so an adapter
cannot pair them wrongly. `outcome` is `not_sent` when the provider did not take
the message and `unknown` when it may have.

| code                    | retryable | outcome  | when                                                                |
| ----------------------- | --------- | -------- | ------------------------------------------------------------------- |
| `invalid_configuration` | no        | not_sent | the adapter or the parser refuses its configuration, before any I/O |
| `invalid_message`       | no        | not_sent | the message fails validation; no I/O                                |
| `mail_not_configured`   | no        | not_sent | the installation has no transport (`ctx.mail.available` is false)   |
| `aborted`               | yes       | unknown  | the caller's signal aborted, before or during I/O                   |
| `network_error`         | yes       | unknown  | fetch threw and no signal aborted                                   |
| `request_timeout`       | yes       | unknown  | the adapter's own timeout fired                                     |
| `request_in_progress`   | yes       | unknown  | a request under the same key is still running                       |
| `idempotency_conflict`  | no        | unknown  | a different message was already accepted under the key              |
| `provider_unauthorized` | no        | not_sent | 401/403: credentials, a suspended key, an unverified sender domain  |
| `rate_limited`          | yes       | not_sent | a burst limit                                                       |
| `quota_exceeded`        | yes       | not_sent | a daily or monthly quota                                            |
| `provider_rejected`     | no        | not_sent | any other 4xx                                                       |
| `provider_unavailable`  | yes       | unknown  | 5xx, or a local store that cannot be written                        |
| `malformed_response`    | yes       | unknown  | a success answer that cannot be parsed                              |

`mayRetryDelivery(error, capabilities)` is the one retry rule: a retryable
error is retried when its outcome is `not_sent`, and an `unknown` outcome only
over an idempotent transport. Over a non-idempotent transport a retry after an
unknown outcome can deliver the message twice.

An error message is a fixed string plus the HTTP status. It never carries a
provider credential, a provider response body, a subject or a message body
([ADR-0019](../decisions/0019-portable-outbound-email.md)).

The package validates the recipient, reply-to and sender addresses, the display
name, the subject, the body and the idempotency key before any provider I/O.

## Configuration

A composition hands the package a provider registry, a name-to-factory map. The
registry is open: a composition can add its own provider. `@fabrika/email/providers`
exports `builtinEmailProviders` (`ahasend`, `lettermint`, `postmark`, `resend`, `smartemailing`), sorted by name, the
order every help text and refusal lists them in. Memory is never
selected by a variable. Directory is a composition input of IAM, and a `directory`
provider that only a local composition registers (below).

`readEmailTransportConfig(env, registry)` parses the variables and
`emailSenderFromEnv(env, registry)` builds the sender, or answers `null` when no
provider is configured. `pickEmailEnvironment(source)` takes the `FABRIKA_EMAIL_*`
entries from Worker bindings or `process.env`. An empty value counts as absent,
because deploy tooling passes an unset variable as an empty string. A refusal is
one `invalid_configuration` error that lists every missing or invalid variable
by name, never by value. To check the values, the parser builds the provider's
sender, which does no I/O.

| variable                                   | secret | rule                                                                                      |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------- |
| `FABRIKA_EMAIL_PROVIDER`                   | no     | absent or `none`: no transport. Otherwise a registry key.                                 |
| `FABRIKA_EMAIL_FROM`                       | no     | required with a provider. A bare address, or the legacy `Name <address>`, which is split. |
| `FABRIKA_EMAIL_FROM_NAME`                  | no     | optional display name; refused when `FABRIKA_EMAIL_FROM` already carries one              |
| `FABRIKA_EMAIL_AHASEND_API_KEY`            | yes    | required for `ahasend`; an API key v2 scoped to `messages:send:{domain}` at least         |
| `FABRIKA_EMAIL_AHASEND_ACCOUNT_ID`         | no     | required for `ahasend`; `[A-Za-z0-9-]{1,64}`                                              |
| `FABRIKA_EMAIL_LETTERMINT_PROJECT_TOKEN`   | yes    | required for `lettermint`; a project API token                                            |
| `FABRIKA_EMAIL_LETTERMINT_BROADCAST_ROUTE` | no     | optional, the project's broadcast route slug (`[A-Za-z0-9_-]{1,64}`), default `broadcast` |
| `FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN`      | yes    | required for `postmark`; a server token                                                   |
| `FABRIKA_EMAIL_POSTMARK_BROADCAST_STREAM`  | no     | optional, the server's broadcast stream ID (`[A-Za-z0-9_-]{1,64}`), default `broadcast`   |
| `FABRIKA_EMAIL_RESEND_API_KEY`             | yes    | required for `resend`                                                                     |
| `FABRIKA_EMAIL_SMARTEMAILING_USERNAME`     | yes    | required for `smartemailing`; visible ASCII, no `:`                                       |
| `FABRIKA_EMAIL_SMARTEMAILING_API_KEY`      | yes    | required for `smartemailing`; visible ASCII                                               |
| `FABRIKA_EMAIL_SMARTEMAILING_TAG`          | no     | optional, `[A-Za-z0-9_-]{1,64}`, default `fabrika`                                        |

Each provider declares its own variables with their secret flag, so deploy
tooling knows which go to secret storage.

## Built-in providers

What each built-in provider offers, and what it has been checked against. "Live" means requests and answers were
recorded on a real account and the received messages inspected; "stubbed" means only the unit tests and the
conformance kit against a stubbed `fetch`.

| provider        | idempotent | confirmation | unsubscribe | attachments | broadcast                      | checked against                                                                               |
| --------------- | ---------- | ------------ | ----------- | ----------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| `ahasend`       | yes        | `sync`       | yes         | 12 MiB      | no (its terms)                 | live, 2026-10-22                                                                              |
| `lettermint`    | yes        | `sync`       | yes         | 15 MiB      | its broadcast route, unchecked | live, 2026-10-22                                                                              |
| `postmark`      | no         | `sync`       | yes         | 10 MiB      | its broadcast stream           | live, 2026-10-22                                                                              |
| `resend`        | yes        | `sync`       | yes         | 25 MiB      | tagged `category: broadcast`   | live, 2026-10-22                                                                              |
| `smartemailing` | no         | `queued`     | no          | none        | no                             | stubbed ([backlog 180](../backlog/180-verify-the-smartemailing-adapter-on-a-live-account.md)) |

A provider that is not idempotent leaves a message whose outcome is unknown (a timeout, a lost answer, a 5xx) to a
person: it is never sent again automatically (`mayRetryDelivery`). When a provider is checked live, update its row and
its section below.

## HTTP adapters

Every built-in provider extends `HttpEmailSender` (`packages/email/src/http-sender.ts`), which holds what they share:
it validates the sender identity and the timeout (ten seconds by default) when it is built; validates the message,
refuses an unsubscribe URL without `listUnsubscribe` and attachments beyond `maxAttachmentBytes` before any I/O; sends
the request through the portable Fetch surface; and classifies the answer. An adapter supplies only its provider's
mapping: the request for a message, the message ID of an accepted answer, the refusals it tells apart beyond the HTTP
status. The limits a provider sets on a valid message are capabilities (`maxAttachmentBytes`,
`refusedAttachmentExtensions`, `minBodyLength`), which `validateEmailAttachments` and `validateEmailBodies` check
before any I/O and the conformance kit exercises. An adapter checks its credentials before the base checks the sender.
Every other refusal is classified by status alone (`refusalByStatus`): 401 and 403
`provider_unauthorized`, 429 `rate_limited`, 5xx `provider_unavailable`, any other `provider_rejected`. A provider's
error text never reaches an error.

A new provider is one module (its sender and its `EmailProvider` declaration), its entry in
`builtinEmailProviders` (`builtinEmailProviderVariables` lists every provider's variables from it), its release in
`builtinEmailProviderSince` (the release after the newest one published without it; the type refuses a provider
without one), its
`package.json` export, a unit test and a conformance harness. The installers, the
Cloudflare workflow and its README read the registry, so neither needs an edit.

A provider that takes a shorter idempotency key than the contract's 256 characters gets one through
`providerIdempotencyKey`: a longer key is sent as `sha256:<hex>` of it, the same digest on every retry.

## Resend adapter

`ResendEmailSender` (`@fabrika/email/resend`) calls the Resend HTTP API. It sends the idempotency key in Resend's
idempotency header and quotes a display name that holds RFC 5322 specials. Capabilities: idempotent, `sync`, `listUnsubscribe`, and `maxAttachmentBytes`
of 25 MiB: it sends attachments as base64 `attachments`, which stays within Resend's 40 MB message bound. It writes the
unsubscribe URL as the two message headers.

A 409 is `request_in_progress` for `concurrent_idempotent_requests` and
`idempotency_conflict` for `invalid_idempotent_request`. A 429 is
`quota_exceeded` for `daily_quota_exceeded` and `monthly_quota_exceeded`, and
`rate_limited` otherwise. A repeated request under its key answers the first `id` and sends nothing, and the retry of a
request that lost a concurrent race gets the winner's `id`. A wrong key is a 401 and a sender on an unverified domain a
403, both `provider_unauthorized`; an invalid recipient is a 422, and a key over 256 characters or a message over
40 MB a 400, `provider_rejected`. Every refusal names its kind in `name`. Resend sends through Amazon SES: the
`Message-ID` is SES's, not the `id`.

A `broadcast` message goes through the same API, which Resend's terms allow for marketing mail sent to one recipient
at a time with consent and an unsubscribe; it carries the tag `category: broadcast`, so the account's logs and webhooks
tell it apart. Checked live: the recipient got it with the message's own unsubscribe headers.

## Postmark adapter

`PostmarkEmailSender` (`@fabrika/email/postmark`) calls `POST https://api.postmarkapp.com/email` with the server
token in `X-Postmark-Server-Token`, through the server's default transactional stream. Postmark has no idempotency
key, and a 200 with `ErrorCode: 0` means it took the message. Capabilities: not idempotent, `sync`,
`listUnsubscribe` (the two headers as `Headers` name and value pairs), and `maxAttachmentBytes` of 10 MiB less one
byte: Postmark counts the decoded bytes of every attachment together, not their base64, and refuses 10,485,760 or more
with a 422 (`ErrorCode` 300); the bodies take up to 5 MB each beside them. It refuses an attachment by its extension
(`ErrorCode` 411): `vbs`, `exe`, `bin`, `bat`, `chm`, `com`, `cpl`, `crt`, `hlp`, `hta`, `inf`, `ins`, `isp`, `jse`,
`lnk`, `mdb`, `pcd`, `pif`, `reg`, `scr`, `sct`, `shs`, `vbe`, `vba`, `wsf`, `wsh`, `wsl`, `msc`, `msi`, `msp` and
`mst`, which the adapter refuses as `invalid_message` before any request.

A refusal is read by its numeric `ErrorCode`, never its `Message`. A wrong token is a 401 (`ErrorCode` 10). A 422 is
`quota_exceeded` when the account is out of credits (405), `provider_unauthorized` for a sender without a signature
(400) or with an unconfirmed one (401) and, per Postmark's documentation, for an account pending approval (412, 413),
and `provider_rejected` otherwise: an invalid recipient (300), an inactive one (406) or a refused file type (411). A repeated request is delivered again. The
`Message-ID` is `<MessageID>@mtasv.net`. Open and click tracking are settings of the Postmark server; with click
tracking on, a one-time link goes through Postmark's redirect.

A `broadcast` message goes through the server's broadcast stream (`MessageStream`), `broadcast` unless
`FABRIKA_EMAIL_POSTMARK_BROADCAST_STREAM` names another; the stream must exist on the server. Checked live: by default
Postmark manages the stream's unsubscribes. It replaces the message's `List-Unsubscribe` with its own one-click link,
appends an unsubscribe footer to the text and the HTML, and keeps whoever uses either in its suppression list, so the
application does not learn of that unsubscribe and Postmark refuses that recipient's next broadcast (406,
`provider_rejected`). The application's own link in the body still works. Managing unsubscribes yourself (handling
`None`) takes Postmark support's approval.

## AhaSend adapter

`AhaSendEmailSender` (`@fabrika/email/ahasend`) calls `POST https://api.ahasend.com/v2/accounts/{account}/messages`
with a bearer API key v2 and one recipient. It sends the idempotency key in `Idempotency-Key`, which AhaSend keeps
for 24 hours and takes up to 255 characters. Capabilities: idempotent, `sync`, `listUnsubscribe`, and
`maxAttachmentBytes` of 12 MiB: AhaSend refuses a message over 20 MiB once its attachments are base64 and
MIME-wrapped.

A 202 carries one result per recipient; a result with `status: 'error'` is `provider_rejected`, without its text,
and any other status with an ID is accepted. A
409 is `request_in_progress`; a 422 whose `message` names the idempotency key (the key reused for another request) is
`idempotency_conflict`, any other 422 `provider_rejected`; and a 404 (no such
account; a key of another account answers 401) `provider_unauthorized`; a malformed request, an unverified sender
domain or a bad recipient is a 400, `provider_rejected`. A request under a key whose first request is still running
waits for it and answers its result with `Idempotent-Replayed: true`. AhaSend renders content as a template only when
the request carries substitutions, which the adapter never sends, so `{{`, `{%` and `{#` reach the recipient as
written. The `id` is the message's `Message-ID`, `<uuid@sender domain>`.

## Lettermint adapter

`LettermintEmailSender` (`@fabrika/email/lettermint`) calls `POST https://api.lettermint.co/v1/send` with the project
token in `x-lettermint-token`, through the project's default route. It sends the idempotency key in
`Idempotency-Key`, which Lettermint keeps for 24 hours and takes up to 255 characters. Capabilities: idempotent,
`sync`, `listUnsubscribe`, and `maxAttachmentBytes` of 15 MiB: Lettermint refuses a request over 25 MB with its
attachments base64. A text or HTML body shorter than three characters, which Lettermint refuses, is `invalid_message`
before any request. An accepted answer counts by its `message_id`, whatever its status.

A repeated request under its key answers 202 with the first `message_id` and sends nothing (no `Idempotent-Replayed` header), a 256-character key is refused with a 422, and a
refusal carries only a `message` (401) or a `message` with field `errors` (422, for an unverified sender domain, an
invalid recipient or a short body). Neither 409 carries a code or a `Retry-After`: the adapter reads the text only to
find "payload", the key reused with another body, which is `idempotency_conflict`. Every other 409, a
concurrent request under the key and, per Lettermint's guide, an earlier one whose outcome is unknown, is
`request_in_progress`: a retry over an idempotent transport cannot deliver twice. As the recipient got them, the
display name was quoted, the subject RFC 2047-encoded, `Reply-To` and both unsubscribe headers written, attachments
byte for byte with their media types and UTF-8 names, and an HTML template unchanged, its links not rewritten. The
`Message-ID` is `<message_id>@lmta.net`. Open and click tracking are settings of the Lettermint project or route; with
click tracking on, a one-time link goes through Lettermint's redirect.

A `broadcast` message goes through the project's broadcast route (`route`), `broadcast` unless
`FABRIKA_EMAIL_LETTERMINT_BROADCAST_ROUTE` names another. A project has only its transactional route until one is
created; a route the project lacks is a 422 that the adapter answers as `provider_rejected`, naming the variable. Not
checked live: the test project had no broadcast route, so how Lettermint treats the unsubscribe headers there is not
known.

## SmartEmailing adapter

`SmartEmailingEmailSender` (`@fabrika/email/smartemailing`) calls
`POST /api/v3/send/transactional-emails-bulk` with HTTP Basic credentials and one
task per request. It sends the content in `message_contents`, so no stored
template is needed. The API has no idempotency key and a 201 only queues the
request. Capabilities: not idempotent, `queued`, no `listUnsubscribe` and no `maxAttachmentBytes`: its API
documents no message headers, so it refuses a message with an unsubscribe URL or an attachment. The API takes up to
five tasks per request; `send` carries one.

The adapter follows the official OpenAPI document. Not verified: the status codes for 403, 5xx and an account whose
sending is still disabled; whether a message without `html_body` is accepted
(the adapter omits it when the message has no HTML); the format rules for `tag`.
The `from` and reply-to addresses must be confirmed in the SmartEmailing account.

## Directory capture

`DirectoryEmailSender` (`@fabrika/email/directory`, Bun and Node only) delivers
nothing: it writes each message as a JSON file in an existing directory, one file
per idempotency key. A repeated send of the same message answers the same message
ID; a different message under the key is `idempotency_conflict`.
`readCapturedEmails` reads them back, oldest first, with the key, reply-to and
sender name. It keeps an unsubscribe URL and attachments within the same 25 MiB bound as Resend. It exists for a local composition and its tests; the files hold the
bodies and their one-time links.

`directoryEmailProvider` (same module) selects it with `FABRIKA_EMAIL_PROVIDER=directory`
and `FABRIKA_EMAIL_DIRECTORY`, an absolute path. `FABRIKA_EMAIL_FROM` is required as for every provider, but the capture does not record it.
It is not in `builtinEmailProviders`. The local stack's Control server registers it,
and `@fabrika/app/bun` passes it to an application's boot as a local-only provider,
which boot adds only under a loopback `FABRIKA_IAM_ISSUER`. Anywhere else the name is
an unknown provider.

## Memory stand-in

`MemoryEmailSender` (`@fabrika/email/memory`, runtime-neutral) keeps what it
accepted in memory, for tests and local development. Its capabilities can be set
to model any transport; by default it keeps an unsubscribe URL and attachments within 25 MiB. A test can make it refuse, be unavailable or unreachable,
lose the answer after it took the message, or run a hook during the call.
`handoffs` lists every call that reached it, with the answer it gave.

## Conformance kit

`describeEmailSenderConformance(name, harness)` (`@fabrika/email/conformance`,
under `bun:test`) registers the cases every sender passes: the capabilities, the
accepted result, field fidelity, refusal of each invalid message without I/O, the
caller's abort, the error table, idempotency, and that no credential, response
body, subject or body appears in an error or a log line. An HTTP adapter's
harness supplies a stubbed fetch and its provider's answers; a local sender's
harness says where it stored what it took. Each built-in sender runs it.

The cases that abort or time out while I/O is in flight, during the request or
while the answer body arrives, run for HTTP harnesses only: nothing outside a
local sender can hold its write open. A local harness gets the already-aborted
case.

`parseProviderVariables(schema, env)` (from the package root) parses a provider's
own variables and refuses in the same form as the built-in providers, so
`readEmailTransportConfig` lists an external provider's invalid variables in its
one refusal.

## IAM composition

IAM selects email independently from its authentication methods. It reads the
`FABRIKA_EMAIL_*` variables above (`EMAIL_CONFIG`) against a provider registry
(`EMAIL_PROVIDERS`): the Worker passes `builtinEmailProviders`, and the Bun
composition takes `createRuntime(source, { emailProviders })`, defaulting to the
same. The Bun composition builds the sender at boot, so a bad configuration
refuses to start.

Cloudflare materialization writes `FABRIKA_EMAIL_PROVIDER`, the sender split into
`FABRIKA_EMAIL_FROM` and `FABRIKA_EMAIL_FROM_NAME`, and the provider's non-secret
variables as Worker vars. The provider's secret variables are Worker secrets under
the same names; they never enter plaintext vars.

The Bun composition also takes a sender as a composition input
(`createRuntime(source, { emailSender })`, the `EMAIL_SENDER` port). IAM refuses it
outside `ENVIRONMENT=local` and beside a configured provider. The local stack passes
a `DirectoryEmailSender` this way; no environment variable selects it.

IAM retries no e-mail automatically: each manual resend issues a new action or
rotates the invitation, so it sends under a new key. Each send carries a 30-second
deadline. When an invitation's first e-mail fails with outcome `unknown`, the
link may have arrived, so the invitation stays open. Any other failure deletes
it. Both answer `delivery_failed`. When the message cannot be rendered, nothing
was sent: IAM deletes the new invitation and the call fails.

On Zerops, when IAM has a provider configured and `FABRIKA_CONTROL_URL` is set
(`http://control:3000`, in IAM's setup of the generated `zerops.yaml`), its sender is a
`PlatformEmailSender` to Control's relay with the installation key
`installationMailKey(FABRIKA_IAM_RPC_KEY)` ([the relay](#the-relay)). The relay always
passes IAM's mail and dispatches it with Control's copy of the transport. An `unknown`
outcome then means only that the relay was unreachable. Without a provider, IAM keeps
its manual action-link flow.

IAM owns its enrollment and reset templates, one-time action state, and delivery
behavior. An installation without a sender uses an explicit manual action-link
flow; it does not silently drop an email. Operations still owns its notification
targets, outbox, retry schedule, and operator interface when email alert delivery
is added.

Only an installation administrator (`iam.admin`) receives a manual enrollment or
reset URL. A user administrator's request answers 403 without a sender
([ADR-0058](../decisions/0058-user-administration-is-grantable-on-its-own.md) section 5).
An older release gave a user administrator the enrollment URL of an invited
person. On an existing installation that ran without a sender, the operator
checks for passwords set that way:

1. Through `audit.list` with `action: 'iam.password.enrollment.issue'`, list the
   events whose metadata is `delivery: manual`.
2. Keep each event whose actor does not hold `iam.admin` (neither the built-in
   `admin` role nor a bootstrap mailbox).
3. For each such target, disable the password (`passwords.disable`), which also
   ends its password sessions. Then an installation administrator issues a new
   enrollment, or the person signs in through OIDC.

## The installation's transport

An installation configures at most one transport, for IAM and for the applications
whose jobs declare `mailer: 'installation'`.

- **Zerops.** `fabrika platform install` takes `--email-provider` (`none` by
  default), `--email-from` and `--email-from-name`, or the variables beside them,
  and each variable of the selected provider from the environment only
  (`readInstallationEmail`, `@fabrika/installation-init`). It validates the set and
  writes it on the `iam` and `control` services, service-level, the credentials
  sensitive; it does not copy them into the secrets file. IAM and Control each read
  it at boot. IAM refuses to start on an invalid one; Control starts, logs one line
  naming the variables, and refuses only the deploys that hand the transport.
- **Adding or rotating a transport later.** No command writes it after `install`:
  `platform upgrade` and `platform deploy` write no `FABRIKA_EMAIL_*` and remove
  none, and `install` cannot be re-run. The operator sets the same variables on
  `iam` and `control`, restarts both and redeploys the environments that use it
  (`platform guide --provider=zerops`, "Set or rotate the mail transport"). One
  command for it is [backlog 187](../backlog/187-set-or-rotate-the-installation-mail-transport.md).
- **Cloudflare.** `fabrika platform init` requires `--email-provider` (`none` or a
  built-in provider). It writes the provider's secret variables as GitHub Environment
  secrets and the rest as variables, and the workflow passes every built-in
  provider's variables to IAM; an unset one arrives empty and counts as absent. A
  re-run writes the values it is given and deletes none, so an old provider's
  variables, a display name or a tag stay until the operator deletes them. Control
  on Cloudflare holds no transport: Cloudflare runs no jobs.

## Applications

An application sends from a cron job that declares `mailer`, through `ctx.mail`
([application runtime](application-runtime.md#e-mail-from-a-job)); an endpoint
never sends. `mailer: 'own'` takes the application's own `EmailSender` from
`serve(contract, { mail })`. `mailer: 'installation'` takes the installation's:

- Control reads its transport from its own `FABRIKA_EMAIL_*` at boot
  (`readInstallationMail`, `packages/control/src/mail-transport.ts`): none, a
  transport, or invalid.
- A Zerops deploy whose approved snapshot records framework 0.7.0 or newer (a
  prerelease compares as its release) hands the relay (`relaysInstallationMail`,
  `platformMailEnvironment`): `FABRIKA_EMAIL_PROVIDER=platform`,
  `FABRIKA_PLATFORM_MAIL_URL` (Control's public origin, from `FABRIKA_CONTROL_DOMAIN`)
  and the environment's `FABRIKA_PLATFORM_MAIL_KEY`, and no provider variable. The
  application's project has no private network to Control's, so the platform proxy
  carries the call to the relay's `protocol` row. Control hands them whatever
  its own transport is: the relay holds what it cannot send. A dry run hands the
  provider and the URL without a key. A Control without a vault
  (`FABRIKA_CONTROL_VAULT_KEY`) cannot issue the key, and a Control without a public
  origin has no address to hand: each refuses the deploy.
- Any other deploy whose approved contract has such a job hands the application the
  whole set (`installationMailEnvironment`), its credentials among the values the
  run's logs redact. Zerops writes every name service-level and sensitive. The
  application builds its sender from its own release's registry, so Control refuses
  the deploy before any effect when the installation's provider is newer than the
  release the approved snapshot records (`builtinEmailProviderSince`, `@fabrika/email/providers`),
  naming the provider, the pinned release and the one it needs. The running version
  keeps running.
- Zerops removes the variables a deploy no longer hands, so an environment that moves
  to framework 0.7 loses the provider's credential at that deploy. A Cloudflare deploy
  refuses any `FABRIKA_EMAIL_*` or `FABRIKA_PLATFORM_*`, so a credential never lands in
  a plain Worker variable.
- Without a transport, a deploy that hands the set hands
  `FABRIKA_EMAIL_PROVIDER=none` and nothing else. The application boots, its mailer
  jobs see `ctx.mail.available` false, and every send fails `mail_not_configured`. An
  installation from before the transport has no `FABRIKA_EMAIL_*` on `control`, so it
  lands here with no operator step.
- With an invalid transport, Control refuses a deploy that hands the set before any
  effect, naming the jobs and the operator step. It does not refuse the approval: the
  transport can change after it.
- `FABRIKA_EMAIL_` and `FABRIKA_PLATFORM_` are framework-only families
  (`isEmailTransportVariable`, `isPlatformTransportVariable`, `@fabrika/auth-core`): an
  application's own variable or secret under one is refused at deploy, and the
  refusal says how to delete it.
- A changed transport reaches IAM and Control when they restart, and an application
  that holds the set at its next deploy. The relay dispatches with Control's transport,
  so a relayed application gets the change when Control restarts.

`ctx.mail` puts a prefix of the installation and the application environment in
front of each key, so applications on one provider account never share one. Over a
transport that is not idempotent, an outbox never resends a message whose outcome
is `unknown`.

## The platform transport key

The key an application environment calls the relay with
([ADR-0064](../decisions/0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md),
`packages/control/src/platform-transport.ts`):

- one per `<app>@<env>` and receiver (`mail`): `px_` and 160 random bits, which Control
  generates;
- stored as its SHA-256 hash in `platform_transport_keys`; the value is sealed in the
  vault under `platform:platform-key:<app>@<env>:mail`;
- 30 days of life. A deploy reuses the newest key while more than 15 days are left and
  issues a new one otherwise. A replaced key stays valid by its hash until it expires;
  its vault value is deleted at once. Issuing a key also deletes every expired key row
  of the installation.
- A deploy that no longer needs the key deletes its rows and vault values once the run
  succeeds; until then the running version keeps sending with it. A failed, interrupted
  or dry run deletes nothing. Deleting the application environment deletes its rows.

On Zerops the URL is a plain service variable and the key a sensitive one
(`packages/provider-zerops/src/managed-env.ts`). The error-report scrubber keeps the
URL and `FABRIKA_EMAIL_PROVIDER` and redacts the key.

## The relay

Control's mail relay receives installation mail from applications on framework 0.7
and from IAM on Zerops, records it, gates it and dispatches it through Control's own
transport (`packages/control/src/mail-relay/`). Only the Bun process (Zerops and the
local stack) runs it; on the Worker its row answers 404.

### The wire

`@fabrika/email/platform` holds both sides of the wire (`platform-wire.ts`):

- `POST <url>/platform/mail/send`, `Authorization: Bearer <key>`,
  `Content-Type: application/json`. Control serves it on the `protocol` row
  `mail-relay` (`POST /platform/mail/*`); any other path under it answers 404.
- An application calls it on Control's public host: the platform proxy serves the
  row there, makes no decision and passes `Authorization` on to the relay. IAM calls
  Control's private origin from the installation's project.
- The body is the `EmailMessage` fields, `broadcast` only when true (so a transactional message encodes as it did
  before the field); each attachment is
  `{ filename, contentType, contentBase64 }` (standard padded base64).
  `encodePlatformMailRequest` writes it in a fixed field order, so the same message
  is the same text. `parsePlatformMailRequest` is the one parser: strict (an unknown
  field is refused) and ending in the package's own message validation.
- The relay reads at most the base64 of 10 MiB of attachments plus 4 MiB. A larger
  body, invalid JSON, and a message that fails validation answer 400
  `invalid_message`. So does a `broadcast` message while Control's own sender sends
  none, refused before it is recorded; without a sender yet, it is held like any
  message, and the transport decides at dispatch.
- The answer is `200 { status: 'accepted', messageId }` or `{ error: { code } }`:

  | status | code                    | when                                          |
  | ------ | ----------------------- | --------------------------------------------- |
  | 400    | `invalid_message`       | the body is too large, malformed or invalid   |
  | 401    | `provider_unauthorized` | no bearer, or a key the relay does not know   |
  | 409    | `idempotency_conflict`  | another message was accepted under the key    |
  | 503    | `provider_unavailable`  | the relay cannot look up the key or record it |

`PlatformEmailSender({ url, key, fetch?, timeoutMs? })` (`@fabrika/email/platform`)
is the sender's side. `url` is exactly an http(s) origin. It reads any
`EmailDeliveryErrorCode` from an answer, so the relay's `retryable` and `outcome`
reach the caller unchanged; an answer it cannot read is `malformed_response`. It
passes the conformance kit. Its capabilities (`PLATFORM_MAIL_CAPABILITIES`):
idempotent, `queued`, `maxBatch` 1, `listUnsubscribe`, and `maxAttachmentBytes` of
10 MiB.

### Acceptance and the gate

- The bearer is an application environment's transport key (hash lookup, unexpired,
  receiver `mail`), recorded as the sender `<app>@<env>`, or IAM's installation key,
  `px_` and the hex of `HMAC-SHA256(FABRIKA_IAM_RPC_KEY, 'fabrika-platform-mail')`
  (`installationMailKey`), compared in constant time and recorded as
  `installation:iam`.
- The relay records the message in `mail_messages` under
  `UNIQUE (sender, idempotency_key)`, with the SHA-256 of the canonical body as its
  fingerprint. A repeat with the same fingerprint answers the first `messageId`; a
  different one answers `idempotency_conflict`. The recipient, the subject, the bodies
  and the attachments live only in `content`; the row also keeps the recipient's
  domain, lowercase.
- The gate decides once, when the message is first recorded:
  1. an installation sender: `queued`;
  2. Control has no valid transport (`MAIL_TRANSPORT` none or invalid): `held`;
  3. otherwise the most specific rule of `mail_rules`: the sender's scope with the
     exact domain, then that scope with `*`, then `*` with the domain, then `*`/`*`.
     `pass` → `queued`, `hold` → `held`, `drop` → `dropped`. No rule: `queued`. The
     rule's id is recorded on the message.
- Every decision answers `accepted`. A `queued` message gets one dispatch job.

| state     | meaning                                                |
| --------- | ------------------------------------------------------ |
| `held`    | waits for a person in the console                      |
| `queued`  | waits for the dispatcher                               |
| `sending` | a dispatcher claimed one attempt and sends it          |
| `sent`    | the provider took it; final                            |
| `failed`  | it did not leave; final, a person may requeue it       |
| `unknown` | it may have left; final, for a person                  |
| `dropped` | a rule or a person dropped it; nothing was sent; final |

### Dispatch and maintenance

- The dispatcher consumes the `vozka-mail` queue (`PostgresJobQueue`, in Control's jobs
  table) on its own loop beside `vozka-deploy`, so a long deploy never delays a sign-in
  link. One job sends one `queued`, due message.
- A message can have more than one job (a retry, a release, maintenance), and Control can
  run two consumers. Before the send, a job claims the attempt: one guarded update moves
  the message `queued` → `sending` and counts the attempt, only while the message is due
  and its attempts are the value the job read. A job that loses the claim does nothing. The
  outcome is recorded against that claim; a write that finds the claim gone is logged.
- A claim older than 10 minutes (`MAIL_STALE_CLAIM_S`) belongs to a consumer that stopped
  before it recorded the outcome, so the provider may have taken the message. Over an
  idempotent transport the next job claims one more attempt and sends again under the same
  key. Over any other transport, or when the attempts are spent, the message ends `unknown`
  with `dispatch_interrupted`: it is never sent twice automatically.
- It sends through `emailSenderFromEnv` of Control's own `FABRIKA_EMAIL_*`, with a
  30-second deadline, under the key `relay:<sender>:<key>`; a key longer than 256
  characters becomes `relay:` and the SHA-256 hex of `<sender>:<key>`.
- Success marks the message `sent` with the provider's message id. A retryable error
  that `mayRetryDelivery` allows (a retryable `not_sent`, and an `unknown` outcome only
  over an idempotent transport) is retried after one minute, doubled per attempt, at most
  30 days apart, for ten attempts: the last one some 8.5 hours after the first. This is the
  schedule of an application's queue table with its default one-minute tick
  (`@fabrika/db`), which a 0.6 application's outbox retried its mail on; the relay took
  that retry over when the application moved to 0.7. Any other error, and the tenth, makes
  the message `failed` (outcome `not_sent`) or `unknown`. Without a transport a queued
  message waits, spending no attempt, and maintenance enqueues it again until Control has
  one; content that no longer parses fails as
  `invalid_message`.
- An installation message's content is purged as soon as the dispatcher makes it final
  (`sent`, `failed` or `unknown`): it holds a one-time link. Until then the relay keeps
  it for its retries, and the console withholds it from every caller.
- Control's maintenance pass (cron) re-enqueues `queued` messages unchanged for 10
  minutes whose retry is due, and `sending` messages whose claim is stale, at most 100 a
  pass. It purges the content of final messages 30 days after their last change. A held
  message keeps its content.

### The console

The Delivery section's **Mail** page lists messages by state, held first, with a
filter by state and sender. A message's detail shows its metadata and, with
`mail.content.read` and for an application's message only, the recipient, subject,
text, the HTML body in a sandboxed frame that runs no script, and each attachment's
name, type and size. A held message has
**Release** and **Drop**, each with a confirmation. A message the relay would send again
has **Requeue**, with a confirmation. The rules section sets and removes rules.

| action              | grants                                              | scope                                                                |
| ------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| `mail.read`         | the list and a message's metadata                   | an application's messages at its app or environment; others globally |
| `mail.content.read` | the recipient, subject, bodies and attachment names | global; never an installation sender's                               |
| `mail.manage`       | release, drop, requeue, and the rules               | global                                                               |

Only `admin` holds them by default. The procedures (`controlRpc.mail`):

- `messages.list({ state?, scope?, cursor? })`: without `scope` it needs a global
  `mail.read`, with one the grant that reads that sender (as `runs.list`); 50 a page.
- `messages.get({ id })`: the content is `withheld` without `mail.content.read`, and
  always for an installation sender, whose mail carries one-time links;
  `purged` once it is gone. `requeueable` says whether a requeue would act now.
- `messages.release({ id })` and `messages.drop({ id })`: act on a `held` message only,
  else 409; record who decided. A release enqueues the dispatch, so on the Worker it
  answers 503.
- `messages.requeue({ id })`: acts on a `failed` message, and on an `unknown` one only
  over an idempotent transport, whose content is kept, else 409. It moves the message to
  `queued` with its attempts spent anew, records who decided, and enqueues the dispatch;
  on the Worker it answers 503. An installation message's content is purged once it is
  final, so it cannot be requeued.
- `rules.list()`, `rules.set({ scope, domain, action })` (one rule per scope and
  domain; `scope` is `*` or an existing `<app>@<env>`, `domain` is `*` or a lowercase
  domain) and `rules.remove({ id })`.

### Rollout of an existing installation

- Migration `0013_mail_relay.sql` adds `platform_transport_keys`, `mail_messages` and
  `mail_rules`. The `mail-relay` row changes the console table, so `platform deploy`
  rewrites `FABRIKA_SERVICE_TABLE_DIGEST`.
- An installation starts with no rules: every application message passes.
- An application environment moves to the relay at its first deploy on framework 0.7.
  The deploy hands Control's public origin, which every installation already sets
  (`FABRIKA_CONTROL_DOMAIN`).
  An older release keeps the set and sends directly; the gate does not cover it.
- IAM moves to the relay with the release whose `zerops.yaml` gives it
  `FABRIKA_CONTROL_URL`. Its `FABRIKA_EMAIL_*` stay.
- Before the upgrade, give Control the same `FABRIKA_EMAIL_*` as IAM. Without a
  transport, Control refuses IAM's messages with `mail_not_configured`.
- IAM deploys before Control. Until Control runs the new release, IAM's messages
  fail.
- IAM offers the manual link only when it has no sender of its own. While the relay
  refuses, an administrator's enrollment, reset or invitation answers 502
  `password action email delivery failed`, and a self-service password reset shows
  its usual answer while no mail leaves (backlog 194).
- A provider's refusal of a relayed message shows in Control's Mail page, not in
  IAM's log.

See [ADR-0019](../decisions/0019-portable-outbound-email.md) for the package
boundary and rejected alternatives.
