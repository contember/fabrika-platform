---
id: 0061
title: A file is a value in a table column
status: accepted
date: 2026-10-20
---

# 0061 — A file is a value in a table column

## Context

Framework 0.5 stored files in collections. `c.files({ owner, read, write, delete, maxPerOwner, link })` declared a
collection owned by one dimension table, and the framework generated its endpoints (`/api/files.<name>.upload`,
`.list`, `.download`, `.remove`, and the same under link mounts), with no hook. A row of `fabrika_files_<name>` copied
its owner's whole scope chain. Framework 0.5.5 added files to `c.form`: a received file waited, owned by nobody, in
`fabrika_form_files` for seven days until a job attached it to a record.

That model had these limits:

- The owner row had to exist before the file, and a file could not be written in the same transaction as its data.
- No handler or job could write a file. A handler could only list, open and remove the owner's files.
- A file belonged to exactly one owner. A file shared by two records, an attachment reused by many e-mails, a
  versioned document and a handover between owners each needed a new operation.
- An application table had no file collection at all ([ADR-0012](0012-fabrika-app-runtime.md) §7: an application
  table has no dimension to own it).
- The generated endpoints were operations encoded in a declaration ([ADR-0012](0012-fabrika-app-runtime.md) §9).
  Anything a collection needed beyond them became an option with its own runtime: the form's files added a table, a
  hold, a sweep path and a job-only `attach`.

What must keep holding:

- **The proxy is the only enforcement point** ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)). A file is
  served only by an endpoint the decision selected, with the file treatment of its row.
- **A file reaches only what a capability reaches.** No request names a file by a raw id.
- **A scanning kind's file is served only after a clean verdict**, by its scanned object version.
- **A framework release drops nothing an application stored.** An application may skip framework releases.

## Decision

**A file is a value in a table column. A file kind declares storage policy; the table's policy is the file's
authority. Reading the column under the table's `read` action lets a request serve the file; writing it needs the
action that writes that column. The framework generates no file endpoint.**

### 1. The declaration

```ts
// contract
files: {
	attachments: c.files({ types: ['application/pdf', 'image/png'], maxBytes: 10485760, scan: true }),
},

// table policy
deal_attachments: {
	scope: { child: 'deals' },
	actions: { read: 'crm.read', insert: 'deals.write', delete: 'crm.delete' },
	insert: ['file', 'name'],
	files: { file: 'attachments' },
	createdBy: 'created_by',
},
```

- A **file kind** (`c.files({ types, maxBytes, scan? })` under `files: { <kind>: … }`) has no owner, no actions and no
  endpoint. A `scan: true` kind admits files of at most 100 MiB, the most the scanner reads.
- A **file column** (`files: { <column>: '<kind>' }` in a table policy) holds the id of a row of `fabrika_files`. The
  application's migration writes `<column> uuid references fabrika_files (id)` and an index the column leads; the
  checker's `file-column-migration` rule verifies both for every declared file column.
- A procedure takes a file as an input field: `file('<kind>')`, `z.optional(file('<kind>'))` or
  `z.array(file('<kind>')).max(n)` at the top level of a mutation's input. Its body is then `multipart/form-data`: the
  JSON input in the first part, named `input`, then one part per file under its field's name. One request carries at
  most 20 files.
- A procedure answers a file with `output: file('<kind>')`. A query with a file output is a `GET`, its input read from
  flat scalar URL parameters, so `<img src>` and `<a download>` work for a same-origin session. A mutation with a file
  output is a `POST` that answers the file after its commit, which is how a download writes an audit row.

### 2. The storage

One framework table, `fabrika_files`: id, kind, status (`pending`, `quarantined`, `live`, `rejected`), size, SHA-256,
sniffed type, name, object key, the scanned object version and scan state, the scope value of its first dimensional
reference, the creating request, the creation time, and a `legacy` marker for a migrated file (§6). Bytes live in the
object store under `<kind>/<id>`. No two rows share an object.

### 3. Writing

A file column accepts four values. The data layer refuses anything else, a string id included:

- an incoming file of this request's input;
- a file that `ctx.files.put('<kind>', bytes, { type, name })` of this request staged;
- a file reference this request read from another file column under that table's `read` action;
- `null`, which clears a nullable column.

Every file must be of the column's kind. Its row is locked `FOR SHARE` while the write checks its status, so a file
being deleted cannot gain a reference. The first reference from a table scoped by a dimension stamps the file's scope
value (the top-level value of the chain) with a conditional update; a reference from an application table stamps
none. A reference from another top-level scope is then refused.

**Staging** is the same for an incoming file and a `put`:

1. A `pending` row is committed on a connection of its own, never the handler's transaction, before any byte is
   written. That row is the cleanup intent. So `put` works inside a transaction too. Its connection counts against the
   pool and, on a public procedure, against the in-flight share. A job puts a large file before its transaction.
2. The object is written, sniffed against the kind's types and bounded by the kind's `maxBytes`; size and SHA-256 are
   recorded.
3. The first write of the file into a column, in the handler's transaction, claims it: still `pending`, of this request
   and kind, within the pending grace (one hour). It becomes `quarantined` (a scanning kind) or `live`.
4. After a known rollback the request deletes its unclaimed rows and objects. After an uncertain outcome (a lost commit
   answer, a crash) it deletes nothing; the sweep decides from the database.

`put` exists in a mutation, a public mutation, a job and a webhook delivery.

### 4. Reading and serving

- A row read through the data layer carries a **file reference** in each file column, with its metadata (`id`,
  `name`, `type`, `size`, `status`). The data layer loads the metadata of every row in one statement per read, so a
  list shows it without a call per file.
- A reference read under an action other than the table's `read` (a `getForUpdate` under `update`) carries the
  metadata only.
- A handler passes a readable reference on: `ctx.files.open(ref)` gives the bytes, a file output returns it, and a
  mailer job's `ctx.mail.send({ attachments: [ref] })` attaches it. A file list is a query of the table that holds
  the column.
- Every byte consumer reads only a `live` file, by its scanned object version. A `pending` or `quarantined` file
  answers 409 `file_not_ready`, a `rejected` one 409 `file_rejected`, and a reference whose file the sweep has deleted
  since the read answers 404. The framework applies these from the reference's status; the handler writes no check.
- A file output compiles to a **file-response profile** (`response: 'file'`) in its manifest row and in the row's
  endpoint digest. The proxy and the application apply the file treatment of ADR-0022 rule 2 from the row, denials
  included. A public `GET` query may cache a file answer (`http.cache`, ADR-0012 §11); inline display stays limited to
  inert images.
- The typed client gives `api.<group>.<procedure>.url(input)` for a `GET` file procedure and a same-origin session,
  and `download(api.<group>.<procedure>, input)` for any file output, with the caller's credential. A link holder's
  key never goes into a URL, so a link page uses `download`.

### 5. Removing

Clearing the column or deleting the row removes the reference. The framework's sweep job finds, in bounded batches
over an indexed column per file column, the files past the grace that no declared column references, pending files
included. It deletes each in three steps:

1. In one transaction, it deletes the file's row and records the object key in `fabrika_file_deletions`. The foreign
   key refuses the delete while any reference exists, and a reference write that holds the row `FOR SHARE` makes the
   delete wait, so a file that gains a reference survives.
2. After that commit, it deletes the object.
3. It deletes the deletion record. A crash between the steps leaves the record, and the next sweep finishes it.

The grace counts from the file's creation, so an old file goes at the next sweep once nothing references it.

**Rule: a handover writes the new reference before it deletes the old one, in one transaction.** Written in two
transactions, the sweep can delete the file between them, and the second write fails on the foreign key.

### 6. Existing files

Nothing the framework stored is dropped by a framework release:

1. The framework migration `0008_files.sql` creates `fabrika_files` and copies every held row of each
   `fabrika_files_<collection>` table into it with the same id, object key, status and scan state, marked `legacy`
   with its collection. A row whose owner was deleted is not copied. The old tables stay; they hold the owner mapping.
   A form's held file (`fabrika_form_files`, framework 0.5.5) moves too, its grace counted from the end of its hold.
2. The sweep never deletes a legacy file.
3. The application's own adoption migration first calls `select fabrika_files_copy_legacy('<collection>')`, which
   copies what an older instance wrote after `0008` (an older version keeps serving during a rollout), then fills its
   new table from the old one by id.
4. Its last adoption migration calls `select fabrika_files_release('<collection>')`. The function copies again, refuses
   while a copied file is referenced by no file column (the application then adds one more adoption migration), clears
   the marker of the rest, records for deletion the objects only the old table knew, and drops the old table.

The migration classifier admits the two calls, the file column's foreign key, and an adoption `INSERT` that reads a
collection's table ([ADR-0017](0017-service-owned-postgres-migrations.md)). The steps for an author are in
[`framework-migrations.md`](../reference/framework-migrations.md).

### 7. A public file field

A public procedure that takes a file declares `admission.rate.bytesPerHour`, a challenge and a scanning kind. Its
files are staged after the challenge (ADR-0063). `bytesPerHour` is charged from the declared `Content-Length`, at most
the body limit (the whole body limit without one), before the body is read, and stays charged whatever the request
does next.

## Consequences

- A file is written in the same transaction as its data, by any site that holds the action that writes the column.
- A file shared by two records, an attachment reused by many e-mails, versioned documents, a thumbnail, metadata
  beside an attachment and a handover between owners need no new operation: they are columns and rows.
- An application table holds file columns, so a mail template or a bulk send carries attachments.
- Each file operation an application wants is a procedure of a few lines, which the approval reads like any other and
  the generated access tests cover. The approval shows file reach as table reach: "`deals.write` writes
  `deal_attachments.file` (attachments)" ([ADR-0050](0050-approved-access.md)). A file kind adds no authority.
- A limit per owner (0.5's `maxPerOwner`) is the handler's: a count of the owner's rows under the owner's lock.
- An unreferenced file lives at most the pending grace. A referenced file lives until the application deletes its
  row; the application's retention is its own, not a framework timer.
- An `sql: 'write'` site can write any file id into a column. The approval already treats it as full reach.
- **Mixed proxy versions.** A row with the file-response profile is refused by an older proxy's strict manifest
  parser, instead of served without the file treatment.
- **0.4 and 0.5 applications.** The platform keeps serving their collection rows, their link-served collection rows
  and the form rows of 0.5.5 with files, and keeps `0005_form_files.sql` and `0006_form_bytes.sql` in the framework
  bundle: migration identity is `(bundle, filename)` (ADR-0017), and no released migration is changed or dropped
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)).
- **Rollout.** `fabrika db migrate` applies `0008_files.sql` before the application's own bundle at the next deploy
  of an application on framework 0.6. The Zerops provider adds the sweep and the scan to the crontab of an
  application that declares file kinds. No generated installation file or variable changes. On Zerops a namespace
  proxy pinned before the upgrade refuses a manifest with the file-response profile, and Control does not refuse such
  a deploy: the operator re-pins the namespace first
  ([`deployment-namespaces.md`](../reference/deployment-namespaces.md)).

## Alternatives considered

- **An owner chain on the file row, with `move`/`moveTo`** (the 0.5 model). One owner per file, no sharing, and every
  operation shaped by one handover.
- **Immutable blobs plus attachment records with `share`/`transfer`.** Keeps collection policies, but adds a second
  record type and two operations to the same end.
- **One generated download route per file kind.** The last generated data endpoint, with no audit row. A procedure
  with a file output covers it.
- **Delete the object first, then the row** (the 0.5 sweep). A reference written between the check and the row delete
  points at lost bytes. The deletion record keeps the order safe.
- **Migrate collections through a view the next release drops.** An application that skips that release loses the
  owner mapping, and the sweep deletes every migrated file. Legacy copies the application releases itself lose
  nothing.
- **Presigned uploads.** They win for large media, resumable uploads and high volume. They hand a credential to a
  client and move the sniff and the size bound out of the framework. Not now.
- **Upload first, then submit with the upload's id.** Two anonymous requests need two challenge tokens or an
  unchallenged upload endpoint. One multipart request carries both.
- **The file base64 in a JSON body.** A third more bytes over a phone's connection, and the whole body decoded in
  memory.
