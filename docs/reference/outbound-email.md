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
  media type and the bytes. An empty list is none.

The attachments and the unsubscribe URL are part of the content a repeated idempotency key must match.

`send(message, signal)` takes the caller's `AbortSignal`. A successful call
returns an accepted result with a provider-neutral message ID.

Each sender reports its `capabilities`:

| field                | meaning                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotent`         | A repeated send under one key with the same message is not delivered again.                                                           |
| `confirmation`       | `sync`: accepted means the provider took the message. `queued`: it may still drop the request.                                        |
| `maxBatch`           | The most messages one call carries. `send` carries one, so every built-in sender reports 1.                                           |
| `listUnsubscribe`    | Whether it writes the unsubscribe headers. Absent is no: it refuses a message with `unsubscribeUrl` as `invalid_message`.             |
| `maxAttachmentBytes` | The most attachment bytes of one message, every file together. Absent: it refuses a message with any attachment as `invalid_message`. |

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
exports `builtinEmailProviders` (`resend`, `smartemailing`). Memory is never
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

| variable                               | secret | rule                                                                                      |
| -------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `FABRIKA_EMAIL_PROVIDER`               | no     | absent or `none`: no transport. Otherwise a registry key.                                 |
| `FABRIKA_EMAIL_FROM`                   | no     | required with a provider. A bare address, or the legacy `Name <address>`, which is split. |
| `FABRIKA_EMAIL_FROM_NAME`              | no     | optional display name; refused when `FABRIKA_EMAIL_FROM` already carries one              |
| `FABRIKA_EMAIL_RESEND_API_KEY`         | yes    | required for `resend`                                                                     |
| `FABRIKA_EMAIL_SMARTEMAILING_USERNAME` | yes    | required for `smartemailing`; visible ASCII, no `:`                                       |
| `FABRIKA_EMAIL_SMARTEMAILING_API_KEY`  | yes    | required for `smartemailing`; visible ASCII                                               |
| `FABRIKA_EMAIL_SMARTEMAILING_TAG`      | no     | optional, `[A-Za-z0-9_-]{1,64}`, default `fabrika`                                        |

Each provider declares its own variables with their secret flag, so deploy
tooling knows which go to secret storage.

## Resend adapter

`ResendEmailSender` (`@fabrika/email/resend`) calls the Resend HTTP API through
the portable Fetch surface. It sends the idempotency key in Resend's
idempotency header and quotes a display name that holds RFC 5322 specials. Its
own timeout is ten seconds by default. Capabilities: idempotent, `sync`, `listUnsubscribe`, and `maxAttachmentBytes`
of 25 MiB: it sends attachments as base64 `attachments`, which stays within Resend's 40 MB message bound. It writes the
unsubscribe URL as the two message headers.

A 409 is `request_in_progress` for `concurrent_idempotent_requests` and
`idempotency_conflict` for `invalid_idempotent_request`. A 429 is
`quota_exceeded` for `daily_quota_exceeded` and `monthly_quota_exceeded`, and
`rate_limited` otherwise.

## SmartEmailing adapter

`SmartEmailingEmailSender` (`@fabrika/email/smartemailing`) calls
`POST /api/v3/send/transactional-emails-bulk` with HTTP Basic credentials and one
task per request. It sends the content in `message_contents`, so no stored
template is needed. The API has no idempotency key and a 201 only queues the
request. Capabilities: not idempotent, `queued`, no `listUnsubscribe` and no `maxAttachmentBytes`: its API
documents no message headers, so it refuses a message with an unsubscribe URL or an attachment. The API takes up to
five tasks per request; `send` carries one.

The adapter follows the official OpenAPI document and is verified only against a
stubbed fetch. Not verified: the status codes for 403, 5xx and an account whose
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

IAM owns its enrollment and reset templates, one-time action state, and delivery
behavior. An installation without a sender uses an explicit manual action-link
flow; it does not silently drop an email. Operations still owns its notification
targets, outbox, retry schedule, and operator interface when email alert delivery
is added.

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
- A deploy whose approved contract has such a job hands the application the whole
  set (`installationMailEnvironment`), its credentials among the values the run's
  logs redact. Zerops writes every name service-level and sensitive, and removes them
  once a deploy hands none. A Cloudflare deploy refuses any `FABRIKA_EMAIL_*`, so a
  credential never lands in a plain Worker variable.
- Without a transport, the deploy hands `FABRIKA_EMAIL_PROVIDER=none` and nothing
  else. The application boots, its mailer jobs see `ctx.mail.available` false, and
  every send fails `mail_not_configured`. An installation from before the transport
  has no `FABRIKA_EMAIL_*` on `control`, so it lands here with no operator step.
- With an invalid transport, Control refuses that deploy before any effect, naming
  the jobs and the operator step. It does not refuse the approval: the transport
  can change after it.
- `FABRIKA_EMAIL_` is a framework-only family (`isEmailTransportVariable`,
  `@fabrika/auth-core`): an application's own variable or secret under it is refused
  at deploy, and the refusal says how to delete it.
- A changed transport reaches IAM and Control when they restart, and an application
  at its next deploy.

`ctx.mail` puts a prefix of the installation and the application environment in
front of each key, so applications on one provider account never share one. Over a
transport that is not idempotent, an outbox never resends a message whose outcome
is `unknown`.

See [ADR-0019](../decisions/0019-portable-outbound-email.md) for the package
boundary and rejected alternatives.
