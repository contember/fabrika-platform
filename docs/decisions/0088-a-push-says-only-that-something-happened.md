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
  declared (`implement/egress.ts`; [ADR-0075](0075-a-cron-job-may-reach-the-public-web.md) for public egress).
- **Each environment's signing keys are Control's**, sealed in the vault and handed as a framework variable only when
  the approved contract asks for them (`FABRIKA_TOKEN_KEYS`, `packages/control/src/token-keys.ts`). A framework
  variable leaves `process.env` before application code loads, but it stays readable to code in the process (the
  application's CLAUDE.md, "The framework's variables").
- **The framework already generates rows of its own** under `/__fabrika/` (`/__fabrika/connect/…`,
  `/__fabrika/challenge/…`), with reserved prefixes and their own rate buckets, which the approved contract carries and
  the proxy decides like any other.
- **A browser may be shared.** A terminal ([ADR-0067](0067-a-terminal-signs-a-person-in-on-an-application-s-word.md))
  is one browser many people sign in on, and sign-out is the proxy's path (`/__fabrika/auth/signout`), which no page
  handles.

Four facts about Web Push decide the shape:

1. **A push travels through a third party.** The push service of Google (Chrome, Edge on Android, Opera), Mozilla,
   Apple or Microsoft (Edge on Windows) sees the endpoint, the timing and the size of every message. An encrypted
   payload hides its content from that service, but not from the device: the notification's text is shown on a locked
   screen to whoever holds it.
2. **Every push must show a notification** (`userVisibleOnly: true`). Chrome shows a generic one when the worker shows
   none, and Safari revokes the permission after a few pushes that showed nothing. A design whose pushes can arrive with
   nothing to show loses the permission.
3. **The subscription endpoint is chosen by the browser, so by whoever controls the page.** An application that sends
   to whatever endpoint it was handed sends a signed request to any URL: a request forgery from the application's own
   network, carrying its VAPID token.
4. **A subscription belongs to a browser, not to a person.** It outlives a sign-out and serves whoever signs in next.

## Decision

**We will let an application notify a person through Web Push without any of its data leaving under a push: the push
is empty and says only that something happened, and the service worker reads the notification's text from the
application under the person's session, through the proxy, when the push arrives. A push is sent only to a
subscription that has something unseen, of the person it is bound to, that the person may still read. The platform
writes the worker, holds the sending key and sends; the application declares that it notifies and names whom, about
what.**

### 1. The contract declares it

A contract that notifies declares so in a literal the static reader reads (ADR-0005), and the approval diff shows it as
a widening: the application gains three generated rows, two framework tables and a sending job, and sends to the push
services. Without the declaration none of the following exists. A platform release whose reader does not know the
declaration refuses the contract (ADR-0062).

### 2. Three generated rows under a reserved prefix

The build reserves `/__fabrika/push` (as it reserves `/__fabrika/challenge`), so no authored row and no root SPA
answers a path under it, and generates three rows there, each credentialed with caller `human` and requirement `member`
(any permission of the application), each with its own rate buckets per caller (as the challenge rows have,
`defaults.ts`):

- `GET /__fabrika/push/worker.js`: the service worker, a fixed script of the framework release.
- `POST /__fabrika/push/subscription`: the page records, replaces or removes the caller's subscription of this browser.
- `POST /__fabrika/push/inbox`: the worker names its subscription and gets the caller's unseen notifications for it.
  It is a `POST` because it moves the subscription's cursor; a session `POST` needs `Sec-Fetch-Site: same-origin`
  (ADR-0022 rule 3), which a worker's own request carries.

The build and the contract checker refuse an authored path under the prefix.

### 3. The worker controls no page

It is registered with the scope `/__fabrika/push/`, where no page lives, so it intercepts no request of the
application. It has no `fetch` handler and uses no cache. It keeps in IndexedDB only what the fixed notice needs without
a session: the application's name and the page's locale, written when the page subscribes. A worker update check that
meets an expired session gets a 401 and keeps the installed version.

It handles three events:

- `push`: post the subscription's endpoint to the inbox and show what it answers (below).
- `notificationclick`: open or focus the notification's path, which must be a same-origin path of an SPA mount.
- `pushsubscriptionchange`: record the browser's new subscription through the subscription row, which replaces the old
  one only for the person it was bound to. Without a session the row cannot be asked, and the old endpoint is already
  dead; so the worker keeps the pair (old endpoint, new subscription) in IndexedDB, and the page posts it as a
  replacement on its next load, under the same rule. Until then the person gets no push; the inbox still holds the text.

### 4. A push carries no payload, and the inbox decides what is shown

The sending job posts an empty message with only the VAPID authorization and its headers (section 8). Nothing the
application wrote reaches the push service, so nothing needs the RFC 8291 encryption. On `push`, the worker posts
`{ endpoint }` to `/__fabrika/push/inbox` with the browser's cookies; the proxy decides it under the person's session
as it decides any request. Then:

- **200 with notifications:** the worker shows each one, at most 5, and when the inbox held more, one summary
  notification instead of the rest ("N more in <application>").
- **200 with nothing visible** (the rows were filtered out, section 6, or a race left nothing unseen): the worker shows
  the fixed notice, "<application>: open to see what is new", in the stored locale, whose click opens the start URL.
  Section 5 makes this rare, and it is still a notification, so the permission stays. The fixed notice always carries
  one `tag` and no `renotify`, so each one replaces the last instead of stacking: a session that expired while
  notifications keep coming (the cursor does not move on a 401) shows one notice, not one per push.
- **200 saying the subscription is not the caller's** (section 7): the worker unsubscribes the browser and shows the
  fixed notice.
- **401** (no session): the worker closes every notification of the application it showed (`getNotifications()`, then
  `close()`) and shows the fixed notice. The subscription stays; the next sign-in in this browser reads it again.
- **403** (the person may no longer use the application): the worker closes every shown notification, unsubscribes the
  browser and shows the fixed notice. The push service then answers the next send 404 or 410, which deletes the row.

### 5. A push is sent only when there is something to see

Each subscription row keeps a cursor: the newest notification the inbox answered for it. The sending job sends only to
a subscription whose person has a notification newer than its cursor, and the inbox moves the cursor when it answers.
Pushes to one subscription carry one `Topic`, so a push service holding several undelivered pushes delivers the last
one. A burst of `ctx.notify` for one person therefore becomes one push per device, and one inbox read shows them all.

### 6. A notification names what it is about, and the inbox checks it when it is read

`ctx.notify(person, { title, body, path }, about)` in a handler or a job writes a row in the framework's notification
table, in the invocation's transaction, and kicks the sending job after the commit
([ADR-0060](0060-a-handler-kicks-a-declared-job-after-its-commit.md); section 8). `about` names what the **recipient**
must hold to read the text: an action the contract declares, and the object it applies to (a dimension and its key) or
the whole application. It is the reader's action, not the sender's: a customer who submits an order
(`orders.submit`) notifies staff about it with `{ action: 'orders.read', on: { order: id } }`. The sender needs no grant
of that action, because `about` grants nothing: it only narrows who may read the text the sender already wrote. The
types and the runtime refuse an action the contract does not declare and a dimension the action does not apply to. The
row stores the action and the object's dimension and key, or the application. `title` and `body` are bounded plain
text; `path` is a literal path of one of the application's SPA mounts. A row lives 7 days.

The inbox answers only the caller's own rows, and of those only the ones the caller may still read now: it checks
each row's action on its object (or its containers) against the caller's current claims, the same check an `on`
endpoint makes ([ADR-0012](0012-fabrika-app-runtime.md), [ADR-0085](0085-a-grant-holds-a-set-of-scope-values.md)
included), and the action as a global grant for an application-wide row. A person who lost the action, the scope or the
object does not read text written for it. A notification the operating system already shows stays in its notification
centre until the next inbox read answers 401 or 403 (section 4); that is the one window revocation does not close at
once.

### 7. A subscription is bound to the person who recorded it, and a terminal records none

A subscription row holds the caller's principal id (from the verified token, never from the body), the endpoint, the
subscription's keys, the VAPID key it was made for, and its cursor. At most 10 per person: an eleventh replaces the
oldest. A push service's 404 or 410 deletes the row.

The subscription row also answers which person a browser's subscription is bound to (`{ status, endpoint }`: the
caller's, another person's, or unknown). The `@fabrika/ui` control shows notifications as on only when it is the
caller's, so person B never sees "on" for a subscription that still wakes for person A.

When the inbox is asked for an endpoint whose row names another principal than the caller, it deletes the row and
answers that the subscription is not the caller's; the worker unsubscribes (section 4). So a browser where person A
subscribed and person B signs in stops waking for A at A's next push, and never shows A's text to B. The `@fabrika/ui`
sign-out control unsubscribes the browser before it navigates to `/__fabrika/auth/signout`, which closes the window
before that push.

A caller on a terminal (a token with the `terminal` claim, ADR-0067) cannot record a subscription: the row answers
403. A terminal is a shared browser by definition.

### 8. The platform sends, only to the push services

The sender is a **framework job** (`FrameworkJob`, the reserved name `fabrika-push`, as the file scan job is). It holds
no IAM key: it reads only the framework's own tables. It runs two ways:

- **Kicked after the commit** that wrote a notification, in the process that committed it. Today the kick path resolves
  only contract jobs (`bound.get(name)` in `jobs/runner.ts`), so this is new code: the kick path learns the one
  framework job, under the same lease and coalescing as a contract job's kick. Without it a notification would wait up
  to a minute, which is the recovery's delay, not the design's.
- **Scheduled every minute** as the recovery, where the framework's jobs are scheduled today: a crontab entry
  (`fabrika job run`, `build-recipe.ts`) on Zerops, the serving process's schedule where no crontab runs
  ([ADR-0080](0080-the-serving-process-keeps-the-job-schedule-where-no-crontab-runs.md)), the environment object's
  alarm on Cloudflare.

A framework job runs one attempt per run, so retries are per row, not per job: a row the push service refused for now
keeps a `next_attempt_at`, and the next run that finds it due sends it again.

An endpoint is recorded, and sent to, only when it passes the egress guard of `implement/egress.ts` with a fixed origin
list in the framework: `https://fcm.googleapis.com`, `https://updates.push.services.mozilla.com`,
`https://web.push.apple.com` and `https://*.notify.windows.com`. Any other is refused at the subscription row. The
send is a framework facility (`platformFacility`), outside every site's egress, and adds no egress any site may use.

Each send is one `POST` with `redirect: 'manual'` (a 3xx is a failure), bounded in time and size, carrying:

- `Authorization: vapid t=<JWT>, k=<public key>`, signed with the key the row was made for (section 9), the JWT
  signed ES256 with `aud` the push service's origin, `exp` 12
  hours ahead (RFC 8292 allows at most 24) and `sub` the environment's public origin (`FABRIKA_APP_ORIGIN`; Apple
  requires a `sub`). An environment without a public origin cannot notify, and the deploy says so.
- `TTL: 86400`: a push older than a day is dropped by the service, and the inbox still holds the text for 7 days.
- `Urgency: normal` and the subscription's `Topic` (section 5).

A 201 moves on; 404 and 410 delete the row; 429 and 5xx set the row's `next_attempt_at` from the answer's
`Retry-After` (at least a minute, at most an hour) and leave it. A 403 is a logged failure code like any other answer,
never the answer's body: the row was signed with its own key, so a 403 says nothing a deletion would fix.

**Bounds.** A person gets at most 30 pushes an hour across their devices; notifications beyond that are stored and
shown in the next push's inbox read, so none is lost. The inbox answers at most 20 rows per read.

### 9. Control holds the sending key

For an environment whose approved contract notifies, Control generates one P-256 VAPID key pair, seals the private key
in the vault and hands it as a framework variable, like the token keys; the public key reaches the page in the mount's
`__fabrika-config.json`. A rotation is an operation on one environment, and it works as the token keys' does: the next
deploy hands the new key first and each retired key after it. A subscription is created only with the current key, but
the sender signs each row with the key the row was made for, so a rotation drops no subscription. The page replaces an
old-key subscription at its next load (section 10), and a retired key leaves the variable once no row names it, or 30
days after its retirement: a browser that has not opened the application in 30 days subscribes again through the
control.

**The private key is in the application's environment, as the token keys are, so code in the application's process can
read it.** With it, the application's code could send a push of its own, with a payload, to its own subscriptions. "A
push carries no payload" is a property of the platform's worker, which ignores `event.data` and shows only what the
inbox answers; a payload the application sends is never shown. The key reaches only that environment's subscriptions.

### 10. The page asks, once, and keeps the subscription current

`@fabrika/ui` offers a control that asks for the permission on a click (browsers refuse a prompt without one) and
records the subscription with the application's name and locale for the fixed notice; on iOS it says the application
must be on the Home Screen first. No page asks for the permission on load.

On load, where the permission is already granted and the browser's subscription was made for an older key, the page
replaces it without asking: it unsubscribes, subscribes with the current key and posts the replacement naming the old
endpoint. The row accepts a replacement only when the old endpoint's row belongs to the caller, so a key rotation never
binds a shared browser to whoever is signed in now. The old row still exists then, because the sender kept signing it
with its retired key (section 9). The page posts a replacement the worker kept from a `pushsubscriptionchange` the same
way (section 3).

## Consequences

- **Revocation reaches the text at the next read.** The inbox checks each row against the caller's current claims when
  the push arrives, so a person who lost the application, a scope or the action reads nothing written for it, and a
  browser shared after a sign-out never shows the previous person's text. What the operating system already shows stays
  until the next read answers 401 or 403, which closes it (Decision 6).
- **The push services learn timing, never content.** They see that an application's origin sent something to a device,
  and when. The device's lock screen shows the text, which the application's author writes; the skill says to keep
  names and amounts out of it where the screen may be seen.
- **A notification needs the network twice:** the push, then the inbox. Both happen only while the device is online,
  so this adds a request, not a failure mode. A lost push is recovered by the next one: the inbox holds the text.
- **No IAM change.** Subscriptions, notifications and the sending job live in the application, the key in Control's
  vault. IAM's sessions and memberships decide the inbox through the proxy, as they decide every request.
- **Provider-neutral.** The rows, the worker, the tables and the job are the framework's, on Postgres and on a Durable
  Object's SQLite alike; Control's key reaches every provider as a framework variable.
- **The data has a lifecycle like any application data.** Backups and exports carry both tables: subscription
  endpoints and keys, and notification text. A restore brings back subscriptions that may be stale, which the next send
  (404, 410) or the next inbox read (another principal) removes; it never sends a person anything they may not read,
  because the inbox checks the claims. Deleting a person's data deletes their rows in both tables, which are keyed by
  principal id, and the erasure path must name them.
- **`fabrika app dev` shows pushes instead of sending them.** The dev kit records each push in its outbox view with the
  inbox answer it would read, as it shows mail; it holds no VAPID key and calls no push service.
- **The contract format gains a declaration, a row source and two framework tables.** Older proxies parse the rows
  (their kinds are `query` and `mutation`); an older platform's reader refuses the declaration
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)).
- **The rollout path of an existing installation:** nothing to converge until an application declares it; Control's
  first deploy of such a contract generates the key. No generated installation file changes.
- **A device check gates the sending code.** The rows, the worker and the inbox may land first; the sending job lands
  only after Safari on iOS has shown that a Home Screen application signs in again after an expired session (ADR-0087's
  open question) and receives an empty push.

## Alternatives considered

- **The notification's text in an encrypted payload.** The usual design: works without a second request. Rejected for
  the first version: once sent, the text reaches a device whose person may since have lost access, and a browser handed
  to another person after a sign-out shows the previous person's text. Reading it under the session keeps ADR-0022's
  rule that every answer meets the proxy. Kept as an option for an application that must show text offline, as its own
  declaration.
- **Send to every subscription of the person on every notification.** Simpler, and wrong under fact 2: a coalesced run,
  an inbox already read or another person's subscription would push with nothing to show, and Safari would revoke the
  permission. The per-subscription cursor and the principal check send only where there is something to see.
- **`about` as the sender's capability** (the previous draft). The inbox would check the reader for the sender's
  action, and the two usually differ: a customer submits an order (`orders.submit`), staff read it (`orders.read`), and
  staff would get only the fixed notice. Authors would then grant senders the reader's action just to make
  notifications work, which widens access. Rejected for a declared action the recipient must hold.
- **Delete a subscription on the push service's 403 after a key rotation** (the previous draft). The page's
  replacement on its next load names the old row, which the next send had already deleted, so the replacement was
  refused and the subscription lost. Rejected for signing each row with its own key until it is replaced.
- **Subscriptions in IAM.** IAM knows people across applications and could delete a subscription when a membership
  ends. Rejected for now: a subscription is bound to one application's origin anyway, the inbox read already enforces
  revocation, and IAM is the installation's most sensitive service; a person-wide notification centre would be its own
  decision.
- **The sender as a generated `job:` entry of the contract.** A declared job gets a workload key from IAM. Rejected for
  a framework job: the sender reads only the framework's tables and calls no IAM operation, so a key would be a
  credential nothing uses. The file scan job is the precedent.
- **The proxy sends, or a platform service sends.** It would keep the sending key out of the application's process.
  Rejected for now: the proxy holds no state and makes one decision (ADR-0022), and a new installation service is
  heavy for one POST per device. The key is the environment's own, like its token keys, and reaches only that
  environment's subscriptions (Decision 9 says what that leaves open).
- **A worker scoped to the whole host, with a `fetch` handler.** It would allow offline pages later. Rejected: it would
  stand between every request and the network, and ADR-0087 keeps answers uncached.
- **Accept any endpoint the browser hands over.** Rejected: fact 3. A new push service joins the list in a framework
  release.
- **Let a terminal subscribe.** Rejected: a terminal is shared by definition (fact 4), and the principal check would
  turn every sign-in there into an unsubscribe.

## Open questions

- **Safari on iOS** (the gate above): does Apple's service deliver an empty push to a Home Screen application, and does
  the worker reach the inbox with the application's own cookie jar before it must show the notification? If an empty
  push is not delivered, the push carries an encrypted payload holding only an opaque notification id, and the text is
  still read under the session.
- **A click in an installed application.** Does `clients.openWindow` of a path inside the manifest's scope open in the
  installed window on each platform, or in a browser tab?
- **The API's exact form**: the declaration's place (the vocabulary, `defineApp`'s options or the contract), the name
  `ctx.notify`, the bounds of `title` and `body`, and the shape of `about`. Because `about` names a declared action and
  a key rather than a capability (Decision 6), a job names what a notification is about the same way a handler does.
- **The runtimes.** ES256 signing through WebCrypto (`crypto.subtle`, P-256) on Bun and workerd, and an empty push
  without `aes128gcm` content encoding accepted by each push service, need a test against each before the sending code.
