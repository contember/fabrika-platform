---
id: 0070
title: Data protection of an application environment on Cloudflare
status: proposed
date: 2026-10-25
---

# 0070 — Data protection of an application environment on Cloudflare

## Context

On Cloudflare an application environment's data is one Durable Object's SQLite
([ADR-0065](0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)). Control reaches the
object over the ops channel and freezes it by generations it allocates
([ADR-0069](0069-control-reaches-an-application-environments-object.md)). Nothing yet copies the data out. The only
recovery is Cloudflare's point-in-time recovery of the object, which rewinds every write since the target time, the
ones that were right included.

The constraints:

- **workerd reads a SQLite integer into a JavaScript double** (`src/workerd/api/sql.c++`), so an integer above 2^53
  rounds. Binding a bigint throws, and `cast(real as text)` keeps 15 significant digits (probe 8, dry run on local
  workerd, sprint run log).
- **A statement is at most 100 KB; a row can be 2 MB.** A dump of SQL text cannot carry a large row in one `INSERT`.
- **R2 refuses a multipart upload whose parts differ in size** (probe 9 dry run, error 10048). A part is at least
  5 MiB, except the last, and an upload has at most 10 000 parts.
- **A request has bounded CPU and memory; a database can hold gigabytes.** Every phase runs in bounded steps.
  Point-in-time recovery rewinds SQLite and KV, and an eviction drops memory, so the state between steps lives in
  Control's operation record, which ADR-0069 makes the authority.
- **`defer_foreign_keys` ends with the request.** `transactionSync` is a savepoint inside the request's implicit
  transaction, so a deferred violation fails only when the request ends, and it resets the object (probe 8 dry run).
- **Point-in-time recovery rewinds the object it is applied to,** up to 30 days back, through
  `onNextSessionRestoreBookmark` and a reset. Applied to the object that serves, it discards every write since then.
- **Files are bytes outside the database.** A row holds the key of its file in the environment's bucket
  ([ADR-0061](0061-a-file-is-a-value-in-a-table-column.md)), and the sweep deletes the bytes of a removed row.
- **Rows are every tenant's data** (ADR-0069 §2). A dump is content; nothing Control logs may carry a value.
- **An installation upgrade changes no application**
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md) rule 5).

## Decision

**Control protects an environment's data with consistent backups that it takes, verifies by importing them, and keeps
in the environment's bucket. Framework code writes and loads every dump over the ops channel in bounded steps that
Control drives. The one recovery flow built is a side restore: the data moves into a clone that takes over serving,
and point-in-time recovery is applied only to the frozen original.**

### 1. Two kinds of dump

| Kind              | Taken                                                                                                                        | Restorable                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Consistent backup | under `read-only` after the acknowledged drain, or from an `inspect` object; `closed` qualifies too, since it writes nothing | yes                         |
| Diagnostic export | while the object is `open`; each step reads what is committed then, so the dump mixes states. It is labelled fuzzy           | no: the importer refuses it |

A consistent step carries the operation's generation. The object refuses it with ADR-0069's stale refusal when that is
not the published generation, and as `wrong_mode` while the object is `open`. A diagnostic step carries no generation.
The manifest records which kind a dump is (`consistent`). A diagnostic export is for an operator to read, never to
restore.

### 2. The producer

`POST /__fabrika/ops/export` runs one step per request, before boot:

1. **`begin`** walks `sqlite_schema`, refuses a schema it cannot dump, starts the multipart upload of the data object,
   and answers the upload id and the object's bookmark (`getCurrentBookmark()`).
2. **`part`** _n_ starts at a cursor and reads keyset pages of at most 1 000 rows, table after table in load order. It
   writes each row as one line, compresses the lines into one gzip member, and uploads it as part _n_. A retried step
   replaces its part. It answers the part's size, SHA-256 and ETag, every table it finished with its row count and
   hash, and the cursor where the next part starts.
3. **`complete`** completes the upload with the parts Control recorded, writes the manifest beside the data, and
   answers the manifest.

Control's operation record holds the upload id, the cursor, the parts and the finished tables. The object keeps nothing
between steps. A cursor names a table, the last rowid read (as decimal text) and the count and hash folded so far: a
digest, never a value. The step code reads `sqlite_schema` and the tables directly. It needs neither the application's
boot nor the framework's tables, so it also dumps a database that cannot boot, or one restored to a time before those
tables existed. R2's lifecycle aborts an upload that never completes.

**Parts of one size.** Every part but the last is exactly one gzip member (RFC 1952) of exactly 8 MiB; the last is at
most that. The producer adds whole rows while the compressed member still fits, starts the next part with the row that
does not, and pads the member to 8 MiB with spaces in its header's comment field (`FCOMMENT`). A row never spans two
parts, so the importer reads, checks and loads any part alone, by its byte range. The data object as a whole is a
multi-member gzip file that any gzip reader decompresses. 8 MiB is above R2's minimum and holds the largest row
uncompressed, its blobs as hex; 10 000 parts bound a dump at about 80 GB compressed, above the 10 GB an object holds.

**What a dump holds.** Every table of `sqlite_schema` but SQLite's internal ones and Cloudflare's `_cf_` tables. It
includes `sqlite_sequence`, so `AUTOINCREMENT` keeps its counter, and the migration ledger's two tables. A row is its
rowid, then every column that is not generated, in declaration order; a rowid alias column repeats the rowid. A table
is read in rowid order, which is its keyset order.

**Load order.** The producer writes tables parents first: it repeatedly places the first table by name all of whose
foreign-key parents other than itself are placed, and when none is left, the first remaining table by name. A foreign
key whose parent is the table itself or a table placed after it is **deferred** (§6). The manifest lists the tables in
this order, and the importer derives the deferred keys from that list and its schema; it never orders anything itself.

**Refused schemas.** `begin` refuses, as `unsupported_schema` naming the table:

- a `WITHOUT ROWID` table, whose keyset would put key values, which are content, into Control's record;
- a virtual table, which the data layer does not read either;
- a table whose name breaks the data layer's identifier rule;
- a deferred foreign key with a column that is `NOT NULL`, which the importer could not write as `NULL`.

### 3. Lossless values

Each column is projected in SQL as `(typeof(c), value)`:

| `typeof(c)` | Projected value   | Encoded as                                                                                 |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `integer`   | `cast(c as text)` | `i:<decimal>`                                                                              |
| `real`      | `c`               | `r:` and ECMAScript's shortest round-trip text of the double, keeping `-0` and `±Infinity` |
| `text`      | `c`               | `t:<text>`                                                                                 |
| `blob`      | `hex(c)`          | `b:<HEX>`                                                                                  |
| `null`      | `NULL`            | `null`                                                                                     |

**A real crosses as the double itself.** workerd loses precision on int64 only; a double reaches JavaScript exactly,
and `Number.prototype.toString` writes the shortest text that reads back as the same double. `cast(real as text)` keeps
15 digits, and `printf` depends on how SQLite converts. SQLite never stores NaN.

**The canonical row encoding** is the `JSON.stringify` of the array of encoded values: no whitespace, NUL escaped,
characters outside the BMP written as they are. ECMAScript specifies `JSON.stringify`, so every runtime writes the same
text. A **line** of the dump is `{"table":"<name>","row":<row encoding>}`, and the data object is gzip-compressed
NDJSON. The importer binds each value back as its own type and never through a double.

**A table hash** starts as the SHA-256 of the empty string. Each row, in keyset order, replaces it with the SHA-256 of
the hash's hex, a newline and the row's encoding. The hash folds page after page and step after step, so the cursor
carries it, and the importer computes it again by reading the loaded table back. A part is checked by the plain SHA-256
of its bytes.

The value and row encodings, the line, the hash fold, the manifest and its parser are defined once, in the ops wire of
`@fabrika/auth-core`; the producer, the importer, Control and the CLI all use them. They are format 1, and a reader
refuses another format.

### 4. The manifest

`manifest.json` is written beside the data at `complete`, and a reader refuses one above 4 MiB. It holds:

- the format, the dump id, the source object's name, `consistent`, and the time the dump was written;
- the bookmark the object answered at `begin`;
- the framework release and the contract digest;
- the DDL: every `sqlite_schema` entry that has SQL, with its type, name and table;
- the migration ledger of both bundles, the framework's and the application's, with checksums and times;
- every table in load order, with its exact row count and its hash;
- every part with its size and SHA-256.

### 5. Where dumps live, and for how long

- **Keys.** A consistent backup lies at `__fabrika/backups/<object>/<dump>/data.ndjson.gz` and `manifest.json` in the
  environment's bucket, a diagnostic export under `__fabrika/exports/<object>/<dump>/`. The dump id is a UUIDv7 that
  Control generates. `__fabrika/` is reserved in the bucket, and the build refuses a file kind of that name (ADR-0069).
- **Retention.** A dump is kept 30 days. An R2 lifecycle rule on both prefixes, which the environment's deploy writes,
  expires it. Control lists only the backups its record holds.
- **Backup retention never exceeds the file tombstone window,** which is 30 days too. Removing a file queues its key,
  and the sweep deletes the bytes only once the key is past the window. A restored row keeps its file's original key,
  so the bytes are still there for any backup within its retention, and a restore cancels the queued deletion of every
  key its rows reference before the object opens.
- **Access** follows ADR-0069 §2: `data.read` lists backups; only `data.content.read` downloads a dump.

### 6. The importer

`POST /__fabrika/ops/import` loads a consistent backup into a fresh object, before boot. Control first publishes the
target `inspect` under the import operation's generation, and every step carries it.

1. **`begin`** reads the manifest and refuses it as `invalid_manifest` when it does not parse or is too large, and as
   `fuzzy_dump` when it is not consistent. It refuses a target that holds any table as `not_fresh`. It writes an import
   marker that names the backup into the target's KV storage, then applies the migrations up to the manifest's ledger:
   each bundle of the release must begin with exactly the manifest's files and checksums, files after them are not
   applied, and any difference is refused as `ledger_mismatch`. The resulting `sqlite_schema` must equal the manifest's
   DDL (`schema_mismatch`). It then drops the triggers, so that no trigger fires on a loaded row. It answers the number
   of parts. A `begin` retried on a target whose marker names the same backup answers again.
2. **`part`** _n_ reads the part by its byte range and refuses it as `part_mismatch` unless its size and SHA-256 match
   the manifest. It inserts the rows with their rowids in one `transactionSync`, which also records the part in the
   marker, so a retried part loads nothing twice. It writes the columns of a deferred foreign key as `NULL`. The
   ledger's tables are replaced by their dumped rows, so the restored ledger keeps its original times. It answers the
   rows it loaded and how many have a deferred key to set.
3. **`link`** _n_, once every part is loaded, sets the deferred keys of part _n_'s rows by rowid, in one
   `transactionSync`. Control calls it only for the parts that reported deferred rows.
4. **`verify`** reads the tables back from a cursor with the producer's projection and fold, and compares each
   finished table's count and hash with the manifest (`verify_mismatch`, naming the table).
5. **`complete`** recreates the triggers from the manifest's DDL, compares the whole schema again, and clears the
   marker. Control may then publish the object `open`.

**`discard`** wipes a target with `deleteAll()`. The object accepts it only in `inspect`, holding an import marker, and
when it is not the object of ordinary traffic.

**Invariant: an object that holds an import marker never boots and never leaves `inspect`.** A half-loaded clone can
therefore never serve.

**Foreign keys are checked immediately.** A key the load order satisfies is checked as each row goes in. A deferred key
is written `NULL` and set by the link pass once every row is in, and that update is checked at once too. A violation
throws inside its step's `transactionSync` and rolls back that step alone, so no violation can reach the end of a
request and reset the object.

### 7. Rehearsal

**A backup is verified by importing it.** Every scheduled backup is imported into the scratch object `rehearsal`,
verified, and then wiped with `discard`. Every deploy at a gated release lists `rehearsal` in
`FABRIKA_APPLICATION_OBJECTS`, so the ops channel reaches it; ordinary traffic never does. A rehearsal that finds the
object not fresh, after an earlier one died, discards it first. A backup whose rehearsal fails is recorded as failed.
The verification of the migration phase (ADR-0069 §3) is this rehearsal.

### 8. Schedule

- **Daily.** Control's existing `*/5` cron starts a backup for each Cloudflare environment at a gated release that has
  a domain (ADR-0069 §1), has not opted out, and has no successful backup from the last day. The operation publishes
  `read-only`, waits for the acknowledgement, takes the consistent backup, opens the object at a new generation, and
  then rehearses. The rehearsal reads the stored backup, so it runs after the object reopened.
- **Before a migration.** A deploy that brings a pending application migration to an environment at a gated release
  runs as one operation under the deploy lease: `read-only`, the backup, its rehearsal, the operation's own deploy, the
  migration request, then `open` at a new generation. A failed backup or rehearsal reopens the object and does not
  deploy.
- **Opting out** stops the daily backup only. The pre-migration backup belongs to the migration phase and always runs.
- An environment on an older release gets no backups, and the console says so.

### 9. Side restore

The one flow built for "the data as it was at time T". Everything runs as one Control operation `<op>`, under the
environment's deploy lease and `data.manage`.

1. **List the clone.** The operation's own deploy adds `application-<op>` to `FABRIKA_APPLICATION_OBJECTS` and leaves
   `FABRIKA_APPLICATION_OBJECT` as it is. The ops channel reaches only a listed object (ADR-0069 §1), and listing it
   before the freeze keeps a deploy out of the read-only window. The operation is refused when the list already holds
   16 names.
2. **Freeze** the serving object: `read-only`, then the acknowledged drain.
3. **Back up** consistently, and rehearse the backup.
4. **Import** the backup into `application-<op>`, published `inspect`, and verify it.
5. **Make the clone authoritative.** Publish the clone `open` and the original `inspect`, so the original never boots
   again. The operation's pointer deploy then writes `FABRIKA_APPLICATION_OBJECT=application-<op>` and keeps both names
   in `FABRIKA_APPLICATION_OBJECTS`. The clone boots, finds an equal ledger, repairs its scheduler and serves.
6. **Rewind the original**, once the clone serves. `POST /__fabrika/ops/restore` runs three steps:
   - **`prepare`** writes the sentinel, the operation's id, into the original's KV storage, and answers the current
     bookmark and the bookmark of T (`getBookmarkForTime`). Control persists the target bookmark, the pre-restore
     bookmark and the sentinel before it arms anything.
   - **`arm`** calls `onNextSessionRestoreBookmark(target)`, answers the undo bookmark, and then aborts the object, so
     its next session starts restored. The answer may be lost to the reset.
   - **`verify`**, after the reset, answers whether the sentinel is still there. Absent means restored. Present means
     the restore did not happen, and the operation arms again. Control then checks the expected schema through the
     view before anything is exported. A retry reconciles against the recorded state and never arms blindly.
7. **Recover the rows.** A consistent export of the original, which is `inspect`, holds them. An author-written job or
   migration applies what is needed to the clone; that step is application-specific.
8. **The clone stays authoritative.** Going back is a new side restore in the other direction, never a pointer flip.
   The original is deleted after the retention period.

**Invariant: point-in-time recovery never touches the object of ordinary traffic.** The object refuses `prepare` and
`arm` as `serving_object` while it is `FABRIKA_APPLICATION_OBJECT`, and as `wrong_mode` unless it is `inspect`.

| Failure                                          | Outcome                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Control dies mid-operation                       | The environment stays in its published mode; a successor fences and resumes from the recorded step   |
| The listing deploy fails                         | Nothing is frozen; the operation fails and the environment is as before                              |
| The backup or its rehearsal fails                | The original reopens at a new generation; the operation fails                                        |
| The import into the clone fails                  | The clone is discarded and the import retried, or the original reopens and the operation fails       |
| The pointer deploy fails                         | The original is intact: it is published `open` again and the clone `inspect`; the service is back    |
| The clone does not boot after the pointer deploy | The original is not rewound yet: a pointer deploy back to it, published `open`, restores the service |
| T lies outside the recovery window               | `prepare` is refused as `bookmark_unavailable`; the clone keeps serving; nothing is lost             |
| The answer to `arm` is lost                      | `verify` decides: an absent sentinel is a restore; a present one arms again                          |
| The object did not reset after `arm`             | `verify` finds the sentinel; the operation arms again                                                |
| The rewound original shows an unexpected schema  | It stays `inspect`; the clone keeps serving; an operator investigates                                |
| A write arrives during the window                | Fenced by generation (ADR-0069 §3); a webhook gets 503 and retries                                   |
| Two objects in one isolate                       | Per-object runtime state keeps them apart; the original is `inspect` and never boots                 |
| The files bucket is shared                       | The original runs no sweep; the tombstones keep the bytes its rows at T reference, for the window    |
| The original keeps billing storage               | Until it is deleted                                                                                  |

**Not built: an in-place restore and a whole-environment rollback.** Rewinding the serving object, exporting, and
restoring forward rests on the forward restore succeeding, which is unprobed, and an undo bookmark lost in transit has
no recovery. Both wait until probe 7 has exercised every failure boundary on a live account.

### 10. The timers view

`POST /__fabrika/ops/timers` reads the pending-work tracker (ADR-0069 §2): every live timer and `waitUntil` promise of
the object, with the stack that registered it, oldest first, at most 500 and the count of the rest. `track` switches
the tracker on or off first. It lives in memory and is off after an eviction. It is diagnostics: it writes nothing and
carries no generation. It holds no row, but a stack may name the application's code paths, so it is
`data.content.read` only.

### 11. The wire

| Operation | Steps                                                    | Generation                                                              |
| --------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `export`  | `begin`, `part`, `complete`                              | the published one for a consistent backup; none for a diagnostic export |
| `import`  | `begin`, `part`, `link`, `verify`, `complete`, `discard` | every step                                                              |
| `restore` | `prepare`, `arm`, `verify`                               | `prepare` and `arm`                                                     |
| `timers`  | one                                                      | none                                                                    |

Every request names its `object`, as ADR-0069's do. Inside the prefix the uniform refusal and the stale refusal stay as
ADR-0069 has them. A step the object refuses after authentication gets 422 with a reason and, where one is at fault,
the table's name. Every answer is parsed by the wire's strict parser.

## Consequences

- A Cloudflare environment has a daily backup that was restored once before it counts, and recovering old data never
  rewinds the data that serves.
- Each daily backup puts the environment in `read-only` for as long as the export takes: seconds for the tens of MB
  typical of an internal application, unmeasured until a live run.
- An environment's bucket holds 30 daily backups and the pre-migration ones. A part's padding stores at most one row's
  worth of unused bytes per 8 MiB.
- A schema with a `WITHOUT ROWID` table, a virtual table, or a deferred foreign key with a `NOT NULL` column cannot be
  backed up; `begin` names the table, and the console shows it.
- Text that is not valid UTF-8 does not survive a dump. The data layer writes JavaScript strings and refuses raw SQL on
  SQLite (ADR-0065 rule 7), so only an authored migration's SQL could store such text.
- No trigger fires while a backup loads; the importer drops the triggers and recreates them from the manifest.
- A side restore makes the service unavailable from the moment the original turns `inspect` until the pointer deploy
  completes. It adds one name to `FABRIKA_APPLICATION_OBJECTS` until the original is deleted, and the list holds 16.
- The dump format is versioned, and a reader refuses a format it does not know. A change to the encoding or the hash is
  a new format.
- What only a live account shows is built against the probes' dry runs and unconfirmed: point-in-time recovery and its
  reset, R2's multipart limits, workerd decompressing a member with a large header comment, and the bookmark format.
- On Zerops an application has no object, and nothing changes.
- **Rollout.** Backups ship in framework 0.9.0, gated by `servesOps` like the channel.
  - **Generated files.** No installation file changes. The environment's next deploy at a gated release writes the R2
    lifecycle rule and lists `rehearsal`; `platform upgrade` alone changes no application.
  - **Environment variables.** That deploy writes `FABRIKA_APPLICATION_OBJECTS` with `rehearsal`; a side restore's
    deploys add the clone. An environment on an older pin gets neither.
  - **Provider state.** An existing environment has no backup until its first daily run after that deploy, and its
    bucket gets the lifecycle rule on the same deploy. Control's schedule state arrives through its own migrations on
    upgrade and starts empty.
  - **Floating pins.** None.

## Alternatives considered

- **SQL text dumps.** Readable, and replayed by any SQLite. Rejected: a statement is at most 100 KB while a row can be
  2 MB, and SQL text has no exact form for an integer workerd reads as a double. `fabrika data dump --sql` renders SQL
  from a dump on the client instead.
- **One R2 object per part.** It needs no fixed size. Rejected: a dump would be thousands of objects, which a download,
  a lifecycle rule and a gzip reader see one by one. A multipart upload is one object.
- **One gzip stream across parts, carrying the remainder to the next step.** It wastes no padding. Rejected: a part
  would start in the middle of a member, so no importer step could read one part alone, and the remainder would need a
  store between steps.
- **`cast(real as text)` or `printf` for reals.** Rejected: the first keeps 15 digits, the second depends on how
  SQLite converts. The double itself crosses exactly.
- **`defer_foreign_keys` for self-referencing keys.** Rejected: deferral ends with the request, and a table spans many
  steps, so a row whose parent lies in a later part fails at the request's end and resets the object. The link pass
  sets such keys once every row is in.
- **A keyset over the primary key**, so that `WITHOUT ROWID` tables could be dumped. Rejected: the cursor in Control's
  record would hold key values, which are content.
- **Moving deleted files to a prefix.** Rejected: a restored row keeps its file's original key, which would no longer
  hold the bytes. Deletions are tombstoned for the retention window instead.
- **In-place point-in-time recovery.** One object and no pointer deploy. Rejected for now: it rewinds the only database
  that serves, and its safety rests on an unprobed forward restore (§9).
