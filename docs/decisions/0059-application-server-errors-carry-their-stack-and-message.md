---
id: 0059
title: Application server errors carry their stack and message
status: accepted
date: 2026-10-15
---

# 0059 — Application server errors carry their stack and message

## Context

An application reports its server-side failures to Operations through the ingest of its own
`FABRIKA_OPERATIONS_DSN` (`packages/app/src/jobs/report.ts`). A request that answers 5xx is one
`RequestFailed` event and a failed job run one `JobFailed` event. Until now both carried a fixed
failure code, the endpoint or job, and a framework reason, and nothing of what was thrown: no
type, no message, no stack. The reason was recorded in `implement/failures.ts` and in the skill:
application code, drivers and the framework's own refusals put request data and credentials in a
message. A driver quotes its connection string with the password; the framework's output check
quotes the row it refused.

That made the issues hard to act on. An issue said `handler_failed` on `api.notes.get` and
nothing more, so triage started by reproducing the failure somewhere else. A failure outside a
request or a job run reached Operations not at all: a boot that throws, an uncaught exception, an
unhandled rejection.

The facts that shape the choice:

- **Operations is access-controlled.** It is a platform plane whose operators are IAM principals
  ([ADR-0016](0016-independent-operations-plane.md)). The platform's log stream is not: whoever
  reads a Zerops service's or a Worker's logs reads every line.
- **Operations redacts at ingest already.** `packages/operations/src/redact.ts` removes URL
  fragments, `Authorization` headers and `px_` credentials before an event is parsed or stored.
  It cannot remove an application's secret values, because only the application's process knows
  them.
- **The process knows most of its secrets.** `captureEnvironment` holds every `FABRIKA_*`
  variable: the service key, the DSN, the proxy secret, the IAM transport key, the workload keys,
  the database URL and the storage keys. The application's own variables are there too, but the
  names the operator declared as secrets (`pipeline.secrets`) stay in Control and the provider.
- **Ingest is Sentry-compatible and bounded.** It reads `exception.values[]` with
  `stacktrace.frames`, titles an issue by the last value, and groups by an SDK fingerprint when
  one is present, otherwise by the last value's type and its last five in-app frames. It refuses
  an envelope above 200 KiB and an ingest message above 120 KiB.

## Decision

We will send what was thrown, scrubbed and bounded, with every server-side error report.

**What a request or job report carries.** The framework's own exception (`RequestFailed`,
`JobFailed`) stays the last value, with its type, message, fingerprint, tags and the request
budget of 30 events per process and minute unchanged. Before it come the thrown value and its
causes, the deepest cause first, as Sentry orders a chain:

- the type: the error's `name` when it is an identifier, otherwise `Error`;
- the message, scrubbed and cut to 2,048 characters. A framework failure (`ServerFault`,
  `CapabilityRefusedError`, `@fabrika/db`'s `CapabilityError` and `QueryRefusedError`) sends its
  reason and catalog text instead, because its message quotes request data or a row;
- the stack frames parsed from the `stack` text of Bun (JavaScriptCore) and Workers (V8): file,
  function, line, column, and an in-app flag that is `false` for a `node_modules` file, a runtime
  frame and a frame without a position. At most the 50 frames nearest the throw are kept;
- the `cause` chain, at most five errors including the thrown one, a cycle cut where it repeats.

The encoded chain stays within 64 KiB: the deepest causes go first, then half of every frame list,
until it fits.

**What is never sent.** The request body, its headers, the input and rows are never read for a
report. Before anything leaves the process, every text of the chain passes the scrubber, which
replaces with `[redacted]`:

- the value of every `FABRIKA_*` variable except the public ones (`FABRIKA_RELEASE`,
  `FABRIKA_APP_ID`, `FABRIKA_ENVIRONMENT`, `FABRIKA_IAM_APP_ID`, `FABRIKA_IAM_ISSUER`,
  `FABRIKA_IAM_RPC_URL`, `FABRIKA_CONTRACT_DIGEST`): the service key, the DSN, the proxy secret,
  the IAM transport key, every workload key, the database URLs and the storage keys;
- the value of every application variable whose name says it holds a secret (`secret`, `token`,
  `passw`, `key`, `auth`, `dsn`, `credential`, `private`, `salt`, `connection`, `cookie`,
  `session`, `signature`, `cert`);
- the user and password of any such value that is a URL, decoded and as written;
- anything shaped like a credential: a JWT (the `X-Fabrika-Token` is one), an `Authorization`
  scheme with its value, a credential header written as `name: value`, a URL's userinfo, and the
  value of a query parameter whose name says it is a credential.

A value shorter than eight characters is not scrubbed: no platform credential is that short, and
replacing it would mangle ordinary text. Operations' own ingest redaction still applies on top.

**The log line does not change.** The server log keeps fixed codes, reasons and catalog texts
only. Operations is the one place a message reaches, because it is the one place with access
control.

**Invariant: an application error's message leaves the process only through the scrubber, and
only towards Operations; no log line of the framework carries it.**

**A failure outside a request or a job run is a crash report.** Its logger is `fabrika.process`,
its tag `crash` is `uncaught_exception`, `unhandled_rejection` or `boot_failed`, and it has no
fingerprint: Operations groups it by the thrown value's type and in-app frames, and titles the
issue by it. There is no framework failure code to group by.

- **Bun (Zerops).** Only with an ingest DSN. A startup that throws is reported, its delivery
  awaited for at most two seconds, and rethrown. Once the process serves, it listens for an
  uncaught exception and an unhandled rejection. The first one is reported, its delivery awaited
  for at most two seconds, the listeners removed and the value raised again, so Bun prints it and
  exits with 1 as it did without a listener. A second crash during that wait is not reported.
  `fabrika job run` installs no listeners: the runner reports its own failures, and a run that
  dies is found as `crashed` by the next run or check.
- **Workers.** The first failed boot of an isolate is reported, through the request's
  `waitUntil`; every later request boots again and fails alike. Once an isolate booted, every
  unhandled rejection is reported through the global `unhandledrejection` event, at most 30 per
  isolate and minute, and the runtime keeps its own handling. A contract Worker has no `scheduled`
  or `queue` handler, so there is nothing else to capture.

A failure is reported once. A request's and a job run's failures are caught where they happen and
never reach the process listeners, which are installed only after the boot succeeded.

**Privacy.** A message can still hold personal data the framework cannot recognize: an e-mail
address, a name, a record's text. The framework scrubs what it can recognize and bounds the rest.
Application authors must not put personal data or secrets into error messages. The skill says so.

## Consequences

- An issue shows where the failure happened and what the code said, for every request, job and
  crash, with the cause chain the console already renders.
- Grouping and titles of `RequestFailed` and `JobFailed` issues do not change: the explicit
  fingerprint and the framework's last value are what Operations reads, with or without the
  thrown value before it. A crash issue groups by the thrown value's type and in-app frames.
- A secret in an application variable with an unremarkable name is not scrubbed. Closing that gap
  needs the platform to hand the runtime the declared secret names
  ([backlog 176](../backlog/176-the-runtime-does-not-know-the-declared-secret-names.md)).
- A Worker is one bundled file, so all its frames are in-app and point into the bundle until its
  server source maps are uploaded. A Bun application runs its TypeScript sources, so its frames
  already name them.
- A crash report on Workers is best effort: the `unhandledrejection` event has no `waitUntil`,
  and the isolate may end before the delivery does.
- Scrubbing patterns can remove more than a credential, such as a query parameter named `code`.
  That loses text, never protection.
- Whoever holds the browser DSN can still forge an event; that is unchanged
  ([backlog 96](../backlog/96-operations-sees-only-failed-job-runs.md)).

## Alternatives considered

### Keep fixed codes only

It sends nothing that could leak, and nothing to act on. An operator reproduces every failure
before reading it, and a crash outside a request stays invisible.

### Send the message and stack unscrubbed

The browser SDK does, and Operations would redact fragments, `Authorization` and `px_`. A driver
error would still deliver the database password, and a failed IAM call the service key: only the
application's process knows those values, so only it can remove them.

### Use the Sentry server SDK (`@sentry/bun`, `@sentry/cloudflare`)

It parses stacks and installs the global handlers. It is also a new dependency that instruments
the runtime globally and attaches request data through its integrations, which every application
would have to configure away. The framework already owns the envelope, the release and the
fingerprints; the parsing and scrubbing it adds are small.

### Send the message only for error classes the application declares safe

Most server failures are a library's or the runtime's `TypeError`, which no application declares.
The issues that need the message most would still have none.

### Scrub in Operations instead of the application

Operations does not know an application's secret values, so it can only match patterns. The
application's process holds the values; it is the one place where a known secret can be removed
before it travels.
