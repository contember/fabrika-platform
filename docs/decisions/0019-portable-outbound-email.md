---
id: 0019
title: Keep outbound email behind one public transport contract, for IAM and for applications
status: accepted
date: 2026-10-15
---

# 0019 — Keep outbound email behind one public transport contract, for IAM and for applications

## Context

IAM needs email for password enrollment and recovery. Operations also needs email notification targets, but that work was deferred because the imported Poplach implementation used a Cloudflare Email Routing binding that has no Bun/Zerops equivalent. Implementing delivery inside either domain would create two provider integrations, two retry classifications, and two places where credentials or message bodies might leak.

Applications send email too. An application writes an outbox row from an endpoint and sends it from a cron job
([ADR-0060](0060-a-handler-kicks-a-declared-job-after-its-commit.md)). Without a shared transport, each application
builds its own transport: a `fetch` to a provider URL from its own variables, its own error classification, its own
idempotency handling and its own test stand-in. Each one holds its own provider key, and nothing refuses a deploy that
cannot send.

`@fabrika/platform` is not the right owner. Its package boundary explicitly forbids opening sockets or performing its own I/O; it contains runtime ports and implementations written only over those ports. Outbound email is already an external service integration. It needs configuration, network I/O, provider error interpretation, and idempotency behavior.

SMTP is not an equal primitive across the supported compositions. A fetch-based provider API is available from both Cloudflare Workers and Bun, but the selected provider must not become vocabulary in IAM, Operations or an application.

The facts that shape the extension to applications:

- **Providers differ in what a failure means.** Resend takes an idempotency key, so a retry after a lost answer is
  safe. SmartEmailing has no idempotency and only queues a request: a retry after a lost answer can deliver twice,
  and an accepted request can still be dropped. A caller cannot decide whether to retry from a `retryable` flag alone.
- **One installation serves many applications.** An installation's provider account is shared. Resend scopes
  idempotency keys to the account (Resend's documentation; not tested here), so two applications that both send
  under `welcome-1` collide.
- **Adapters may live outside this repository.** A client may need a provider fabrika does not build in. The
  interface an adapter implements is therefore public, and so is the test that proves an adapter follows it.
- **A Worker is one bundle.** A Worker cannot load an adapter by package name at runtime. An adapter reaches a
  service through its composition, at build time.
- **Secrets stay service-level** ([ADR-0004](0004-secrets-live-in-the-platform.md)): each service that sends holds the
  configuration itself.
- **An application that holds the credential is ungated.** When every mailer application held the installation's
  provider credential, the platform kept no record of what it sent. It could not hold a new application's mail while
  an operator read it, drop mail to a domain, or show what left.

## Decision

We will publish a separate `@fabrika/email` package with one runtime-neutral `EmailSender` contract. Domain services own recipients, templates, action tokens, durable outboxes, and retry scheduling. The email package owns message validation, provider request translation, credential-safe errors, and the classification of delivery failures.

**Invariant:** Provider credentials, provider response bodies, and email bodies never appear in delivery errors or logs.

Email availability is an explicit optional service capability. A missing sender never silently drops a message and never changes whether an authentication or notification feature is enabled. The consuming domain must select a defined non-email flow or report that delivery is unavailable. An application
that declares a mailer has no such flow, so it does not start without a sender (§3).

Installation mail from an application on framework 0.7 and from IAM on Zerops goes through Control's relay (§8). The
relay records every message. A `drop` rule sends nothing, but the message stays recorded and visible in the console
as `dropped`: an operator's decision, never a silent loss.

### 1. The public contract

`EmailSender` is a public interface. Another package can implement it.

- `send(message, signal)` takes one message and the caller's `AbortSignal`. A message has one recipient, a subject, a
  plain text, an optional HTML body, a required idempotency key, an optional `replyTo` address, an optional
  `fromName` that replaces the transport's display name, optional `attachments` (name, media type, bytes; at most 20)
  and an optional `unsubscribeUrl`. The attachments and the URL are part of the content a repeated idempotency key must
  match. There are no free headers.
- A sender states its **capabilities**: `idempotent` (a repeated send under one key with the same message is not
  delivered again), `confirmation` (`'sync'`: the provider took the message; `'queued'`: it queued the request and
  may still drop it), `maxBatch`, `maxAttachmentBytes` (the bytes of all attachments together; absent: none) and
  `listUnsubscribe` (it writes `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, RFC 8058).
  A sender without one refuses a message that needs it as invalid, on the send. A mailer job attaches stored files by
  their references ([ADR-0061](0061-a-file-is-a-value-in-a-table-column.md)): only a `live` file the attempt holds.
- A failure is an `EmailDeliveryError` with a code. One table maps each code to `retryable` and to an `outcome`:
  `not_sent` (the message did not leave) or `unknown` (it may have). An adapter chooses the code; it cannot pair the
  flags wrongly. Authentication failures, quota, rate limits, an idempotency conflict and the caller's abort each
  have a code of their own.
- No adapter exposes provider response types in its result or error.
- **The one retry rule:** a retryable failure with an `unknown` outcome is retried only over an idempotent transport
  (`mayRetryDelivery`). Over a non-idempotent transport, an unknown outcome stays unknown for a person to resolve.

### 2. Adapters and an open registry

- A service gets its providers from its composition, as a name-to-factory map (`EmailProviderRegistry`), not from a
  closed switch. Each provider declares its variables and parses them; the common ones are `FABRIKA_EMAIL_PROVIDER`,
  `FABRIKA_EMAIL_FROM` and `FABRIKA_EMAIL_FROM_NAME`.
- The built-in, env-selectable providers are **Resend** and **SmartEmailing**, both over `fetch`. Resend is
  idempotent and synchronous. SmartEmailing is neither: it is built from the official API v3 document and has not yet
  been verified against a live account ([backlog 180](../backlog/180-verify-the-smartemailing-adapter-on-a-live-account.md)).
- Two more senders deliver nothing: **Directory** writes each message to a directory for a local composition, and
  **Memory** keeps them in memory for tests and `fabrika app dev`, with controls that inject each kind of failure.
  No variable selects Memory: the test kit and `fabrika app dev` pass it as a boot option (§3). IAM takes a Directory
  sender only as a composition input, and only with `ENVIRONMENT=local`.
- The local stack's Control and applications run their production entrypoints, which take only their environment,
  so they select Directory with `FABRIKA_EMAIL_PROVIDER=directory` and `FABRIKA_EMAIL_DIRECTORY`. Three layers keep
  that local. `directory` is not a built-in provider: only the local compositions register it, the local stack's
  Control server and the Bun adapter's local-only providers of an application. Only Control writes `FABRIKA_EMAIL_*`
  into an application (§4). An application's boot adds its local-only providers only under a loopback
  `FABRIKA_IAM_ISSUER` (§3). Anywhere else the name is an unknown provider, and the boot refuses it.
- A **conformance kit** (`@fabrika/email/conformance`) is the public test every adapter passes, built in or not: the
  message fields reach the provider, invalid messages do no I/O, an abort answers `aborted`, each provider answer maps
  to its code, and no secret, response body or message text appears in an error or in a log line.

### 3. Applications send from a declared job, through `ctx.mail`

- A cron job declares `mailer: 'installation' | 'own'`. Only then does its context have `ctx.mail`: `send`, the
  transport's capabilities and `mayRetry`, bound to the declared transport and to the attempt, so a send outside a live
  attempt is refused. An endpoint never gets `ctx.mail`: an endpoint writes an outbox row, and a job sends it
  ([ADR-0012](0012-fabrika-app-runtime.md) §7: the external call comes after the data work). Only a kit contract
  declares it; `defineContract` has no `mailer`.
- A send error the handler does not catch fails the attempt with the fixed code `mail_failed` and the error's code as
  its reason. The runner retries that attempt only where the one retry rule allows it.
- `mailer` is declared reach in the artifact, so the approver sees it ([ADR-0050](0050-approved-access.md) §3: each
  site's declared reach is shown). Control's approval diff classifies it.
- `ctx.mail` prefixes every idempotency key with a digest of the installation's IAM origin and the application
  environment (`FABRIKA_IAM_ISSUER` and `FABRIKA_IAM_APP_ID`), so two applications, or one application in two
  installations, on one provider account never share a key. An application key is 1 to 200 visible ASCII characters;
  with the 41-character prefix it stays within the contract's 256.
- An application sets `replyTo` and `fromName` per message. The sending address is the transport's.
- On framework 0.7, `FABRIKA_EMAIL_PROVIDER=platform` makes the `installation` transport a `PlatformEmailSender` to
  Control's relay (§8), built from `FABRIKA_PLATFORM_MAIL_URL` and `FABRIKA_PLATFORM_MAIL_KEY`
  ([ADR-0064](0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md)), not from the provider
  registry. It needs no `FABRIKA_EMAIL_FROM`, and a missing URL or key refuses the boot. Its capabilities are the
  relay's: idempotent and `queued`, because the relay records the message and dispatches it later, perhaps after a
  person releases it. An accepted send means "the platform took it", not "the provider took it".
- **No mail is a state, a misconfiguration fails closed.** An installation may have no transport. Control then hands
  a job that declares `installation` the explicit `FABRIKA_EMAIL_PROVIDER=none` (§4), and the application boots. Its
  `ctx.mail.available` is false, and every send fails `mail_not_configured`, outcome `not_sent`, without I/O. An
  outbox leaves its rows queued while mail is not available, and spends no attempt on them; they leave on the first
  run after the operator adds a transport and the application is deployed again. Everything else fails closed: an
  invalid configuration refuses the boot everywhere, an absent `FABRIKA_EMAIL_PROVIDER` refuses it (no deploy wrote
  the variable), and a job that declares `own` refuses it without its own transport. A local installation, one whose
  `FABRIKA_IAM_ISSUER` is a loopback origin, treats an absent transport as `none`, and the boot logs it once per job. A
  deployed IAM never signs under a loopback issuer, so an application that took the exception would verify no token of
  a deployed installation. `FABRIKA_ENVIRONMENT` is a free label, so its value never relaxes the check.
- The test kit and `fabrika app dev` pass a Memory sender as a boot option for every mailer job; the boot then reads
  neither the installation's variables nor the application's own transport. The kit's `mail: 'none'` models an
  installation without a transport.

### 4. The installation's transport

- An installation has one provider configuration: the provider, its credentials, a `from` address and optionally a
  display name. The installer takes it once, from one input, on each cloud. The provider's own variables come from the
  environment only, because an open registry cannot have a flag per variable and most of them are credentials.
- On Zerops, `platform install` writes the same `FABRIKA_EMAIL_*` set on the `iam` and `control` services,
  service-level, the credentials sensitive ([ADR-0004](0004-secrets-live-in-the-platform.md)). The installer writes
  IAM's copy, not Control: Control does not deploy IAM, and a sensitive value cannot be read back, so Control could only
  rewrite IAM and restart it blind. On Cloudflare the installation's GitHub Environment holds the set, and the workflow
  passes it to IAM. Control on Cloudflare holds no transport, because Cloudflare runs no jobs.
- Control is the source for applications. A deploy of an environment whose approved contract has a job that declares
  `mailer: 'installation'` hands it one of two things:
  - **the relay**, on Zerops, when the approved snapshot records framework 0.7.0 or newer:
    `FABRIKA_EMAIL_PROVIDER=platform`, the platform transport's URL and key, and nothing of the provider (ADR-0064).
    Control hands it whether or not its own transport is valid, because the relay holds what it cannot send;
  - **the set**, for an older release or a snapshot that records no release: every `FABRIKA_EMAIL_*` Control holds,
    service-level and always sensitive ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)).

  Once the contract stops declaring it, the deploy hands nothing and Zerops removes the stale variables with the rest
  of the framework's families. The names are framework variables
  ([ADR-0043](0043-validate-and-render-one-zerops-descriptor-meaning.md)), so no application sets them itself.
- As framework variables, the `FABRIKA_EMAIL_*` values are secrets to the error-report scrubber of
  [ADR-0059](0059-application-server-errors-carry-their-stack-and-message.md): it removes each value of eight or more
  characters from an application's reports.
- An installation without a transport deploys such a contract: Control hands `FABRIKA_EMAIL_PROVIDER=none` and no
  other mail variable, so the application tells "this installation has no mail" from "no deploy wrote the variable".
- Control starts with an invalid transport. It logs one line that names the variables, never a value, and refuses
  only the deploys that hand the set, before any effect, naming the jobs and the operator step. One mistyped
  variable must not stop the whole Delivery plane. It refuses at deploy, not at approval: the transport is installation
  state that can change after a contract was approved. IAM still refuses to start on an invalid transport: it has no
  deploy to refuse instead.
- IAM and Control read the transport when they start. An application gets a changed transport at its next deploy;
  nothing fans a change out yet ([backlog 187](../backlog/187-set-or-rotate-the-installation-mail-transport.md)).

### 5. An application's own transport

An application that brings its own provider passes `serve(app, { mail: (env) => sender })`: a function of its own
variables, called once at boot, that answers an `EmailSender` or `null` when the variables configure none. The sender
can be a built-in adapter with the application's own secrets, or an adapter from another package. The installation's
configuration is not involved, and the application's variables never take a `FABRIKA_EMAIL_` name. A `mail` that no
job declaring `mailer: 'own'` uses refuses the boot.

### 6. Local development and tests

- The test kit passes a Memory sender as a boot option, so generated tests need no variables. A test reads what was
  accepted and what was handed off, and injects refusals, outages and lost answers.
- `fabrika app dev` shows one structured mail view for IAM's and the application's messages: recipient, subject,
  text, the HTML body in a sandboxed frame, the key and the outcome. A seed reads the same list.
- The local stack captures the applications' mail in the same directory as IAM's. Its Control holds a `directory`
  transport. It hands it to an older application like any installation transport, and its relay dispatches a 0.7
  application's mail to it. There is no SMTP catcher.

### 7. Applications word IAM's e-mails

An application may word IAM's e-mails (`mail` in its contract): a subject, a plain text and optionally an HTML body per
message and language, with placeholders from a closed set. The HTML body is a closed subset that `mailHtmlTokens`
(`@fabrika/auth-core`) admits: text structure only, no attribute but a link's `href`, and a link only to
`{{actionUrl}}`, `{{appUrl}}` or a `mailto:` address. The build, the checker and IAM's reconcile refuse anything else,
and IAM renders the body from its tokens, never from its source, with every value escaped. `{{appUrl}}` is the
application's first registered return origin, built when IAM sends the message; a template that names it while no
origin is registered is sent in IAM's own wording.

### 8. Control relays installation mail

Control owns the relay. It already holds the installation's transport, the console, and the deploy that hands an
application its variables. The relay runs in Control's Bun process, on Zerops and in the local stack; the Worker has
none and answers its row with 404. Its senders reach it over the platform transport
([ADR-0064](0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md)).

- **Senders.** An application environment on framework 0.7 (`<app>@<env>`, by its transport key), and IAM on Zerops
  (`installation:iam`, by its derived key). IAM sends through the relay when it has an email provider configured and
  `FABRIKA_CONTROL_URL` is set; otherwise it sends as before. Its manual action-link flow without a provider is
  unchanged.
- **Every message is a row.** The relay records the canonical request, its fingerprint, the sender, the recipient's
  domain, the rule that decided it and its state, with or without a provider. A repeat under the same key answers the
  first message id; other content under the key is `idempotency_conflict`.
- **The gate decides once, at acceptance.** An installation sender always passes: IAM's sign-in links do not wait for
  a person. A Control without a valid transport holds every application message. Otherwise the most specific rule by
  sender scope and recipient domain decides: the exact environment with the exact domain, then the environment with
  `*`, then `*` with the domain, then `*` with `*`. `pass` queues the message, `hold` holds it, `drop` records it as
  `dropped` and sends nothing. No rule passes. A rule changed later does not touch a message already decided.
- **The application's send answers accepted for every decision.** `held` and `dropped` are the platform's business,
  not the application's: its outbox row is done once the relay took the message.
- **A person decides a held message.** In the console an operator releases it (`held` → `queued`) or drops it. A
  queued message on a Control without a transport waits, spending no attempt, until Control has one.
- **The dispatcher** sends each queued message through Control's own transport, under a key of its own
  (`relay:<sender>:<key>`), so two senders' keys never meet at the provider. It claims each attempt before the send
  (`queued` → `sending`, guarded on the state and the attempts it read), so of two jobs or two consumers exactly one
  sends. A claim that never recorded an outcome (the consumer stopped) goes again under the same key only over an
  idempotent transport; over any other the message is `unknown`. A retryable failure that
  `mayRetryDelivery` allows is retried on the schedule an application's outbox had before the relay took its mail
  over: ten attempts, one minute apart and doubled each time, about 8.5 hours in all. A shorter horizon would lose in a
  provider outage mail that the application's outbox already counted as done. Then the message is `failed` (it did
  not leave) or `unknown` (it may have). Over a non-idempotent provider an `unknown` message stays for a person, as
  §1 says.
- **A person sends a final message again.** An operator with `mail.manage` requeues a `failed` message, or an
  `unknown` one over an idempotent transport, whose content is kept (`failed`/`unknown` → `queued`, its attempts
  spent anew). The console records who did it, as for a release or a drop.
- **Bodies are secrets.** Reading a message's metadata (`mail.read`) is scoped like runs: an application's messages
  at its application or environment, an installation sender's only globally. Reading the recipient, the subject and
  the bodies is a permission of its own (`mail.content.read`, global), and so is deciding (`mail.manage`, global).
  Only `admin` holds them by default. An installation sender's content is withheld from every caller, whatever the
  message's state: it carries one-time links (enrollment, password reset, invitation), and a console reader without
  IAM rights must not take over an account through one, not even while the message waits for a retry.
- **Content has a retention.** An installation message's content is purged as soon as the dispatcher makes it final
  (`sent`, `failed` or `unknown`), because it carries a one-time link. Until then the relay keeps it for its retries,
  and the console withholds it from every caller. Every other final message keeps its content for 30 days. A held
  message keeps it until a person decides.

## Consequences

- IAM, Operations, applications and future services share one set of adapters without sharing templates or lifecycle state.
- Adding another HTTP provider does not change IAM, Operations or any application contract.
- An application on the installation transport has no transport code, no provider variables and no test stand-in of
  its own.
- Operations still needs its own notification-target, outbox, retry, and operator-UI work; this decision supplies the transport but does not complete that feature.
- A caller must choose stable idempotency keys and decide when to retry a retryable failure. An outbox retries after a
  backoff ([ADR-0060](0060-a-handler-kicks-a-declared-job-after-its-commit.md)), and an `unknown` outcome over a
  non-idempotent transport is not retried at all.
- IAM keeps an invitation whose email outcome is `unknown`: the link may have arrived. Over the relay, IAM's send is
  idempotent and only queued, so `unknown` means only that the relay was unreachable.
- An application on framework 0.7 holds no provider credential, only a key to the relay. An application on an older
  release inside the ADR-0062 window still holds the credential and sends directly: it could send as the
  installation's address to anyone, and the gate does not cover it until the release leaves the window.
- With the relay, Control is on the path of every installation mail. An outage delays mail; the sender retries the
  idempotent send, and the dispatcher's queue survives a restart.
- An `unknown` or `failed` message is final for the dispatcher. A person can requeue a `failed` one, and an `unknown`
  one only over an idempotent transport; over SmartEmailing an `unknown` message is never sent again. An installation
  message cannot be requeued: its content is purged once it is final.
- An installation transport can use only a built-in provider. Another provider needs a relay outside the repository
  ([backlog 178](../backlog/178-an-installation-transport-through-an-outside-relay.md)) or a platform distribution that
  bundles it ([backlog 179](../backlog/179-build-a-platform-distribution-that-bundles-extra-email-adapters.md)).
- A changed installation transport reaches an application only at its next deploy. Until then the application sends
  with the old one, and a provider key that was revoked fails its mail with `provider_unauthorized`
  ([backlog 187](../backlog/187-set-or-rotate-the-installation-mail-transport.md)). The same holds for a transport
  added to an installation that had none: its queued mail leaves after the redeploy.
- **Rollout.** An installation from before the transport has no `FABRIKA_EMAIL_*` on `control`, which reads as no
  transport: its next deploy of a mailer contract writes `FABRIKA_EMAIL_PROVIDER=none`, with no operator step.
  `platform upgrade` and `platform deploy` write no mail variable and remove none, so a transport an operator set by
  hand survives an upgrade. Adding a transport later is a manual operator step (the Zerops guide, "Set or rotate the
  mail transport"). An application variable or secret an older release accepted under `FABRIKA_EMAIL_` is refused at
  its next deploy, and the refusal says how to delete it.
- **Rollout of the relay.** An existing installation has no rules, so every application message passes and nothing
  changes until an operator adds a `hold`. A Control without a transport holds application messages instead of
  handing `none`. An application environment moves to the relay at its first deploy on framework 0.7, which replaces
  its `FABRIKA_EMAIL_*` with the platform variables. IAM keeps its `FABRIKA_EMAIL_*`: it still reads them to decide
  whether it sends mail at all, and Control dispatches with its own copy. ADR-0064 answers the rest of the rollout.
- On Zerops, every `FABRIKA_EMAIL_*` an application gets is sensitive, its provider name and address too, so the
  console cannot show them; the provider contract has no way to mark only some of a family secret.
- Renaming the installation's IAM origin changes the key prefix of every application. A message whose send was in
  doubt across the rename goes out again under a new key, and the provider can deliver it twice.
- A Cloudflare installation cannot drop a mail setting by re-running `platform init`: it writes the values it is given
  and deletes none, so an old provider's variables, a display name or a tag stay in the GitHub Environment until the
  operator deletes them.
- **SmartEmailing's limits.** It has no idempotency, so an unknown outcome is never retried automatically and needs a
  person. It confirms only that it queued a request. The status codes for a forbidden request, a server error and
  disabled sending, a text-only body, the format of `tag` and the wording of a daily-limit 429 are not verified.
- Every adapter sends one message per call (`maxBatch: 1`); batches are
  [backlog 186](../backlog/186-send-email-in-batches.md).
- SMTP-only installations need a future adapter or an HTTP mail gateway. SMTP is not emulated through runtime-specific code in IAM.
- No provider is a permanent platform contract. The registry and the conformance kit are.

## Alternatives considered

### Put `EmailSender` in `@fabrika/platform`

Rejected because a working sender performs external I/O, while the platform package's established boundary forbids I/O of its own. A type-only port there would split one small capability across packages without removing the provider integration.

### IAM relays application email

IAM already holds the configuration, so applications could post their messages to it. That makes IAM, the identity
service, carry every application's content, its volume and its failures. IAM would need an outbox and retries for
mail it does not own. Control relays it instead (§8): it already holds the transport, the console and the deploy.

### A relay service of its own

A new installation service would hold the transport and the queue. Rejected because it adds a service to deploy,
upgrade and secure, while Control already has the transport, a job queue, the console and the deploy that hands an
application its key.

### Drop a message without a record

A `drop` rule that discards the message on arrival would be cheaper. Rejected because a mail an operator cannot see
would contradict the rule that a message is never silently lost. A dropped message keeps its row, its rule and, for
the retention, its content.

### IAM loads adapters by package name

An installation would name an npm package, and IAM would import it at start. A Worker is one bundle and cannot do
that, and on Bun it would run code at start that no build reviewed or locked. Adapters enter through the composition
instead.

### Each application keeps its own transport

Every application would implement the provider call, the error classification, the
idempotency handling and a test stand-in, and hold its own key. Each copy would drift, and none would fail closed. An
application that wants its own provider still has one, through `serve(app, { mail })`.

### Refuse a mailer contract on an installation without a transport

Control would refuse the deploy, and the application would refuse to boot. An installation without a mail provider
could then not run an application that sends any mail, even one whose mail is optional or can wait, and every
upgraded installation would need a provider before such an application deploys. The explicit `none` keeps that state
valid and visible to the job, while a misconfigured transport still fails closed.

### `ctx.mail` on endpoints

A send is external I/O that never rolls back. An endpoint that sends and then fails its commit has sent mail for data
that does not exist, and a lost answer has no record to retry from. The outbox row and the job keep a record.

### An SMTP catcher (Mailpit) for local development

Every adapter is HTTP, so a catcher would need an SMTP adapter that nothing else uses. It would also not show the
idempotency key or the outcome, which are what a developer checks.

### Check an application's links against its registered origins at the reconcile

Rejected because a deploy reconciles the schema before it registers the return origins, so the check would refuse the
first deploy of every application whose e-mail links to itself. `{{appUrl}}`, filled at send time from the registered
origin, links to the application without the application naming an origin at all.

### Check an application's links at send time

Rejected because a message that fails the check could then only be dropped or sent in other words, at the moment a
person waits for it, while the reconcile can refuse every other problem before the deploy completes.

### Keep separate IAM and Operations senders

Rejected because both compositions need the same credential handling, validation, idempotency header, and provider error classification. Duplicating those security-sensitive mechanics creates drift without giving either domain useful independence.

### Use SMTP as the common transport

Rejected for the first adapter because it is not an equally supported, operationally simple primitive in Workers and Bun. An HTTP API uses the portable Fetch surface already used throughout the platform.
