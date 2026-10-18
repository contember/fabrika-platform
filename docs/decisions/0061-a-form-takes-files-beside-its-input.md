---
id: 0061
title: A form takes files beside its input
status: accepted
date: 2026-10-18
---

# 0061 — A form takes files beside its input

## Context

A public intake ([ADR-0012](0012-fabrika-app-runtime.md) §6) lets a visitor without an account submit `c.form`, which
appends one row to its inbox and answers a constant. A cron job drains the inbox into records. Files reached an
application only through a `c.files` collection, uploaded by a signed-in person or by a link holder after the job
e-mailed the link. A registration that must carry a photo (a phone camera picture, several MB) had no way in: the
visitor has no owner record to upload under until the job created it.

What already holds and must keep holding:

- **The proxy is the only enforcement point** ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)). A form is
  an anonymous kind: the proxy reads no credential, and its admission is the content type and the cross-origin rule.
  The body limit, the honeypot, the challenge and the rate buckets are the framework's, because `forward_auth` hands
  the proxy the headers and never the body.
- **A cross-origin form relies on the browser's preflight.** A JSON body is not CORS-safelisted, so a page on an
  unlisted origin never gets its request sent. `multipart/form-data` is safelisted: a browser sends it from any page
  without a preflight.
- **A file reaches what its owner reaches.** A row of `fabrika_files_<name>` carries its owner's key and chain under a
  foreign key, every operation takes a `Ref`, an owner-less row is orphaned and swept, and a `scan: true` upload is
  served only after a clean ClamAV verdict.
- **An inbox row is the only record of the work**, and the job consumes it in its own transaction.

## Decision

**A form may declare file fields. Its request is then one `multipart/form-data` body: the input as JSON in the first
part, each file in a part of its field. A received file waits owned by nobody, its id in the inbox row, until the job
that drains the inbox attaches it to the record it creates, in the same transaction.**

### 1. The declaration

```ts
register: c.form('/register', {
	input: Register,
	appendTo: 'registrations',
	maxBytes: 32768,
	challenge: {
		provider: 'turnstile',
		secret: 'TURNSTILE_SECRET',
		siteKey: 'TURNSTILE_SITE_KEY',
	},
	files: { photo: { collection: 'photos' } }, // required: true refuses a submission without it
})
```

- At most four file fields, one file each. A field name is a lowercase column name, and its inbox has a column of that
  name (`uuid`, nullable unless `required`), which receives the file's id or `null`. It may not be an input field, the
  honeypot, `challengeToken` or `input`.
- Each field lands in a declared collection that has `scan: true`. The collection's `types`, `maxBytes` and
  `maxPerOwner` bound the file; `maxBytes` of the form bounds only its input part.
- **A form with files declares a challenge.** An anonymous upload costs storage and reaches the people who read the
  collection; the per-client bucket does not stop a flood on Zerops ([backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md)),
  and the challenge is the defense that does not depend on the address.
- The artifact records `files` on the form's mount only when declared, so every other form keeps its digest. The row
  admits `multipart/form-data`, and `application/json` as well while no file is `required`: a form that gains an
  optional photo keeps taking the JSON its existing pages send, so the application ships first and each page switches
  to multipart when it is ready. A required file makes the row multipart only. The approval shows each field and its
  collection as a widening, and requiring a file as a narrowing ([ADR-0050](0050-approved-access.md)).
- **Its files write within a budget.** Such a form accepts `FORM_FILE_LIMITS.perForm` (20) submissions a minute
  unless it declares `rate.perForm`, and all its files write at most `rate.bytesPerHour` an hour (512 MiB unless
  declared, at most 64 GiB, never less than its largest file). The budget is counted in `fabrika_form_bytes`
  (`0006_form_bytes.sql`), shared by every instance.

### 2. The request, in order

The framework reads the body as it streams (`implement/multipart.ts`), never whole:

1. The client's request bucket, before the body is read. A declared `Content-Length` past what the input and the files
   can hold is 413. A JSON body (no file is required) takes the form's JSON path from here, its file columns `null`.
2. The first part is `input`, without a filename, as JSON within the form's `maxBytes`; the strict input parse, the
   honeypot (a filled one answers the constant and reads no file) and the challenge come next, all before a byte of a
   file is read.
3. Each further part names a file field once and carries a filename. Its declared `Content-Type` must be one the
   collection admits and its first 512 bytes that type (415). It then reserves its collection's `maxBytes` of the hourly
   budget (429 when they no longer fit), its row in `fabrika_form_files` is written `pending` before its object
   `<collection>/<id>`, which stops at the collection's `maxBytes` (413), and the reservation gives back what the file
   did not use. An empty part without a filename is an empty file input: absent. Any other part, a repeated field and a
   broken body are 400 `multipart`; a body whose connection closed before its end is 400 `aborted`, the sender's and
   never a reported failure, on a JSON form too.
4. A missing required file is 400. One transaction then takes from the form's accepted bucket, inserts the inbox row
   and makes every file `held` for seven days (`FORM_FILE_LIMITS.holdMs`). A submission refused before that append
   deletes the objects it wrote and their rows; a failed delete is the sweep's. One whose append failed leaves its files
   to the sweep: the row may have committed before its answer was lost, and the sweep deletes a file only while its row
   is still pending an hour later, never a held one.
5. The whole body arrives within five minutes (408). The answer is the constant, and `then` kicks as for any form.

### 3. The proxy refuses a multipart form's request from an origin its row does not admit

A browser sends `multipart/form-data` from any page without a preflight, so the proxy refuses at the request what it
refuses at a JSON form's preflight: on a form row that admits `multipart/form-data`, a request whose `Origin` is neither
the application's own (`<scheme>://<host>`) nor admitted by the row (`crossOrigin`, the environment's list or `any`)
is 403 `cross_origin`. A request without `Origin` is no browser's cross-origin request and passes, as a script's JSON
request does. This is admission (ADR-0022 rule 3), decided in the same pass, and the application does not repeat it:
it does not know the environment's origins.

### 4. The job attaches

- `fabrika_form_files` (the framework bundle's `0005_form_files.sql`) holds a received file until it has an owner. No
  endpoint serves it.
- The job declares the collection's `write` action and creates the record in `ctx.transaction`. Only a job's
  transaction attaches: a mutation's `ctx.files` has no `attach`, in its type and at runtime, so no endpoint a person
  calls moves a visitor's file. `tx.ref(action,
  dimension, id)` locates in that transaction, so it finds the record it just wrote, and
  `tx.files('<collection>').attach(ref, id)` takes the held row out of `fabrika_form_files` and inserts the file's row
  under the owner in the collection's own table, `quarantined` until the scan job's verdict. The two are one
  transaction with the record: a rollback leaves the file held.
- `attach` answers `false` when no file of the collection waits under the id (none was sent, another collection's, or
  its hold ended) and `true` again for a file this owner attached before, so a retried attempt answers alike. A file
  another owner holds stays that owner's. The owner's files are counted under its lock; past `maxPerOwner` it throws
  (409), and the record's transaction rolls back with the file still held.
- A file nobody attached — a known address, a dead registration — is deleted by the framework's hourly sweep an hour
  after its hold ended; a pending row of a submission that never committed, after an hour. The claim reads the
  statement's clock (`clock_timestamp()`), so a transaction that began before the hold ended claims nothing after it,
  and the hour keeps the sweep off a claim in flight.

## Consequences

- A registration carries its photo in one request, with one challenge, and the record and its photo appear together.
- The photo is unreadable until the scan's clean verdict, a minute or so after the job ran.
- A challenge token is spent before the files arrive: a file the collection refuses (type, size) makes the visitor
  solve the challenge again. The page should check the type and the size before it submits.
- Memory stays bounded: no part is buffered whole except the input. Bun refuses a request body over 128 MiB.
- **Storage is bounded by the budget, not by the challenge alone.** Each submission makes a new owner, so `maxPerOwner`
  bounds nothing here, and on Zerops the per-client bucket counts one client. Without a budget a form with a 15 MiB
  photo would admit 100 submissions × 15 MiB = 1.5 GB a minute, each needing only a solved challenge. With the defaults
  a form writes at most 20 × 15 MiB = 300 MiB in a minute and 512 MiB in an hour, so at most 12 GiB a day and, since an
  unattached file is held seven days, at most about 86 GiB at rest in the worst case; a form that expects more
  declares `rate.bytesPerHour`. A flood that spends the budget refuses the form's files (429) until the hour ends,
  while JSON submissions without a file still go through: the budget trades the storage of a flood for the photos of
  that hour.
- **Rollout.** Nothing converges on upgrade, because nothing needs to: a form without `files` keeps its artifact, row
  and digest byte for byte. `fabrika db migrate` applies `0005_form_files.sql` with the framework bundle on an
  application's next deploy, and `0006_form_bytes.sql` beside it; both tables stay empty until a form declares files. On Cloudflare the proxy Worker deploys
  with the application. On Zerops `upgrade` does not move a namespace's proxy source pin, and a proxy built from an
  older pin admits a multipart form row without the origin check of §3 (the challenge's host check still stops a
  foreign page). Before an application of a namespace declares a form with files, the operator re-pins that namespace
  (`namespaces update --proxy-source=current`), as for `crossOrigin` (ADR-0022,
  [`reference/deployment-namespaces.md`](../reference/deployment-namespaces.md)). Control does not refuse such a deploy
  into a namespace with an older pin: it would need to know which proxy commits carry the check. That stays the
  operator's step.

## Alternatives considered

- **Upload first, then submit the form with the upload's id.** Rejected: two anonymous requests need two challenge
  tokens or an unchallenged upload endpoint, and binding the upload to the submission needs a secret the page carries.
- **The file base64 in the JSON body.** Rejected: a third more bytes over a phone's connection, the whole body decoded
  in memory, and nothing gained but keeping one content type.
- **Buffer the body and parse it with `Request.formData()`.** Rejected: an anonymous request without a solved
  challenge would make the application hold every file's bytes before it could refuse it.
- **The held file as an owner-less row of the collection's own table.** Rejected: that row is "orphaned" to the sweep,
  the scan and every locator, each of which would need an exception, and every existing collection table a migration.
- **Let a file field land in a collection without `scan`, or make the challenge optional.** Rejected for now: an
  anonymous visitor's file reaches staff; both can be relaxed later if a real need shows.
- **Check the origin of every form in the proxy.** Not needed: a JSON form's browser request already stops at the
  preflight, so the rule stays where the preflight does not run.
