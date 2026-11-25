---
id: 0088
title: A push says only that something happened; the text is read under the session
status: proposed
date: 2026-11-25
---

# 0088: A push says only that something happened; the text is read under the session

## Context

An installed application ([ADR-0087](0087-an-spa-mount-is-installable-under-its-own-access.md)) is still silent while
its window is closed. People want to hear that an order arrived or that a colleague asked them something. A browser
delivers a **Web Push** message to a service worker even when no page of the application is open, and the worker shows a
notification. The pieces are standard: the page subscribes through `PushManager.subscribe` and gets a **subscription**
(an endpoint URL at the browser vendor's push service, and keys); the sender proves itself to the push service with a
**VAPID** key pair (RFC 8292); a payload, if any, is encrypted to the subscription's keys (RFC 8291); the push service
forwards the message to the device (RFC 8030).

What already holds and must keep holding:

- **The proxy is the only enforcement point** ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)). Every
  answer an application gives to a person passes the proxy's decision for that person, now. Revoking a membership or a
  session takes effect within a token's lifetime.
- **No answer of an application is cached on the device** (ADR-0022 rule 2, ADR-0087 Decision 6). An installed
  application keeps its manifest and icons, nothing else.
- **A credentialed outbound request never follows a redirect**, and an application's process reaches only what it
  declared ([ADR-0075](0075-a-cron-job-may-reach-the-public-web.md) for public egress).
- **Each environment's signing keys are Control's**, sealed in the vault and handed as a framework variable only when
  the approved contract asks for them (`FABRIKA_TOKEN_KEYS`, `packages/control/src/token-keys.ts`).
- **The framework already generates rows of its own** under `/__fabrika/` (`/__fabrika/connect/…`,
  `/__fabrika/challenge/…`), which the approved contract carries and the proxy decides like any other.

Three facts about Web Push decide the shape:

1. **A push travels through a third party.** The push service of Google (Chrome, Edge on Android, Opera), Mozilla,
   Apple or Microsoft (Edge on Windows) sees the endpoint, the timing and the size of every message. An encrypted
   payload hides its content from that service, but not from the device: the notification's text is shown on a locked
   screen to whoever holds it.
2. **A browser requires a notification for every push** (`userVisibleOnly: true`). Chrome shows a generic one when the
   worker shows none, and Safari revokes the permission after a few silent pushes.
3. **The subscription endpoint is chosen by the browser, so by whoever controls the page.** An application that sends
   to whatever endpoint it was handed sends a signed request to any URL: a request forgery from the application's own
   network, carrying its VAPID token.

## Decision

**We will let an application notify a person through Web Push without any of its data leaving under a push: the push
is empty and says only that something happened, and the service worker reads the notification's text from the
application under the person's session, through the proxy, when the push arrives. The platform writes the worker,
holds the sending key and sends; the application declares that it notifies and names whom.**

1. **The contract declares it.** A contract that notifies declares so in a literal the static reader reads (ADR-0005),
   and the approval diff shows it as a widening: the application gains three generated rows and sends to the push
   services. Without the declaration none of the following exists.
2. **The framework generates three rows under `/__fabrika/push/`**, a reserved prefix, all credentialed with caller
   `human` and requirement `member` (any permission of the application), decided by the proxy like any row:
   - `GET /__fabrika/push/worker.js`: the service worker, a fixed script of the framework release.
   - `POST /__fabrika/push/subscription`: the page records or removes the person's subscription of this browser.
   - `GET /__fabrika/push/inbox`: the person's notifications newer than a cursor, as JSON.
3. **The worker controls no page.** It is registered with the scope `/__fabrika/push/`, where no page lives, so it
   intercepts no request of the application. It has no `fetch` handler and uses no cache; it keeps only the last
   notification id it showed, in IndexedDB. It handles two events: `push` (read the inbox, show each new notification)
   and `notificationclick` (open or focus the notification's path, which must be a same-origin path). A worker update
   check that meets an expired session gets a 401 and keeps the installed version.
4. **A push carries no payload.** The sending framework job posts an empty message with only the VAPID authorization,
   `TTL` and `Urgency`. Nothing the application wrote reaches the push service, so nothing needs the RFC 8291
   encryption. On `push`, the worker fetches `/__fabrika/push/inbox?after=<last id>` with the browser's cookies; the
   proxy decides it under the person's session as it decides any request. With a session, the worker shows the new
   notifications. Without one, or without access, it shows one fixed notification, "<application name>: open to see
   what is new", whose click opens the start URL and so the sign-in.
5. **The text is application data, stored and answered like any.** `ctx.notify(person, { title, body, path })` in a
   handler or a job writes a row in the framework's table in the application's own database, in the invocation's
   transaction, and kicks the sending job after the commit ([ADR-0060](0060-a-handler-kicks-a-declared-job-after-its-commit.md)).
   `title` and `body` are bounded plain text; `path` is a literal path of one of the application's SPA mounts. A row
   lives 7 days. The inbox answers only the caller's own rows.
6. **Subscriptions live in the application's database, bound to the person who recorded them.** A row holds the
   person's principal id (from the verified token, never from the body), the endpoint and the subscription keys. At
   most 10 per person: an eleventh replaces the oldest. A push service's 404 or 410 deletes the row.
7. **The platform sends only to the push services.** An endpoint is recorded, and sent to, only when it is `https://`
   on the default port and its host is one of a fixed list in the framework (`fcm.googleapis.com`,
   `updates.push.services.mozilla.com`, `web.push.apple.com`, `*.notify.windows.com`); any other is refused at the
   subscription. Every send goes out with `redirect: 'manual'`, a 3xx is a failure, and each request is bounded in time
   and size. The send is a framework facility, outside every site's egress, and adds no egress any site may use.
8. **Control holds the sending key.** For an environment whose approved contract notifies, Control generates one P-256
   VAPID key pair, seals the private key in the vault and hands it as a framework variable, like the token keys; the
   public key reaches the page in the mount's `__fabrika-config.json`. A rotation is an operation on one environment
   and invalidates every subscription, which the pages record again at their next load.
9. **The page asks.** `@fabrika/ui` offers a control that asks for the permission on a click (browsers refuse a prompt
   without one) and records the subscription; on iOS it says the application must be on the Home Screen first. No
   page subscribes on load.

## Consequences

- **Revocation reaches notifications at once.** The text is read under the session when the push arrives, so a person
  whose membership or session is gone sees only the fixed notice. A browser shared after a sign-out shows the next
  person's own notifications, never the previous person's: the inbox answers the caller.
- **The push services learn timing, never content.** They see that an application's origin sent something to a device,
  and when. The device's lock screen shows the text, which the application's author writes; the skill says to keep
  names and amounts out of it where the screen may be seen.
- **A notification needs the network twice:** the push, then the inbox. Both happen only while the device is online,
  so this adds a request, not a failure mode.
- **No IAM change.** Subscriptions, notifications and the sending job live in the application, the key in Control's
  vault. IAM's sessions and memberships decide the inbox through the proxy, as they decide every request.
- **Provider-neutral.** The rows, the worker, the tables and the job are the framework's, on Postgres and on a Durable
  Object's SQLite alike; Control's key reaches every provider as a framework variable.
- **The contract format gains a declaration and a row source.** Older proxies parse the rows (their kinds are
  `query` and `mutation`); an older platform's reader refuses the declaration, so the release gate applies
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)).
- **The rollout path of an existing installation:** nothing to converge until an application declares it; Control's
  first deploy of such a contract generates the key. No generated installation file changes.

## Alternatives considered

- **The notification's text in an encrypted payload.** The usual design: works without a second request. Rejected for
  the first version: once sent, the text reaches a device whose person may since have lost access, and a browser handed
  to another person after a sign-out shows the previous person's text. Reading it under the session keeps ADR-0022's
  rule that every answer meets the proxy. Kept as an option for an application that must show text offline, as its own
  declaration.
- **Subscriptions in IAM.** IAM knows people across applications and could delete a subscription when a membership
  ends. Rejected for now: a subscription is bound to one application's origin anyway, the inbox read already enforces
  revocation, and IAM is the installation's most sensitive service; a person-wide notification centre would be its own
  decision.
- **The proxy sends, or a platform service sends.** It would keep the sending key out of the application's process.
  Rejected for now: the proxy holds no state and makes one decision (ADR-0022), and a new installation service is
  heavy for one POST per device. The key is the environment's own, like its token keys, and reaches only that
  environment's push subscriptions.
- **A worker scoped to the whole host, with a `fetch` handler.** It would allow offline pages later. Rejected: it would
  stand between every request and the network, and ADR-0087 keeps answers uncached.
- **Accept any endpoint the browser hands over.** Rejected: fact 3. A new push service joins the list in a framework
  release.

## Open questions

- **Safari and an empty push.** RFC 8030 allows a message without a body; whether Apple's service delivers one to a
  Home Screen application, and whether iOS lets the worker fetch the inbox before it must show the notification, needs
  a device. If not, the push carries an encrypted payload holding only an opaque notification id, and the text is still
  read under the session.
- **A click in an installed application.** Does `clients.openWindow` of a path inside the manifest's scope open in the
  installed window on each platform, or in a browser tab?
- **A person who lost access.** Should the worker remove the subscription when the inbox answers 403, or only stop
  showing text? A 401 (an expired session) must keep it.
- **The API's exact form**: the declaration's place (the vocabulary, `defineApp`'s options or the contract), the name
  `ctx.notify`, the bounds of `title` and `body`, and whether a job may notify a person it holds no grant about.
- **Rate.** A burst of `ctx.notify` coalesces into one push per device per sending run; whether a person needs a cap
  per hour as well.
