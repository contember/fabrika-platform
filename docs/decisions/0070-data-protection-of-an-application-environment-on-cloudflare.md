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
  workerd, sprint run log). Text read into a JavaScript string loses the bytes that are not valid UTF-8:
  `CAST(x'80' AS TEXT)` and `CAST(x'81' AS TEXT)` read as the same string.
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

1. **`begin`** describes the tables of `sqlite_schema` with the PRAGMAs, applies the schema rule below, refuses a
   schema it cannot dump, starts the multipart upload of the data object, and answers the upload id and the object's
   bookmark (`getCurrentBookmark()`).
2. **`part`** _n_ starts at a cursor and reads keyset pages of at most 1 000 rows, table after table in load order. It
   writes each row as one line, compresses the lines into one gzip member, and uploads it as part _n_. workerd's
   SQLite answers at most 100 result columns and each column reads as two, so a page of a table wider than 49 columns
   reads in several statements over the same rows, in one synchronous turn (`readOpsDumpPage`, which the importer's
   verification reads with too); a row loads with its rowid inline, so a table at 100 columns binds no more than 100
   parameters. A retried step
   replaces its part. It answers the part's size, SHA-256 and ETag, every table it finished with its row count and
   hash, and the cursor where the next part starts. An answer with a next cursor whose part is not exactly 8 MiB does
   not parse.
3. **`complete`** completes the upload with the parts Control recorded, writes the manifest beside the data, and
   answers the manifest.

Control's operation record holds the upload id, the cursor, the parts and the finished tables. The object keeps nothing
between steps but one record per dump. The first `begin` writes `begun` beside the dump, once (a conditional create):
the digest of the object's state, the upload id and the bookmark it answered. A retried `begin` at the same state
replays that answer and opens no second upload; at another state it is refused as `ledger_mismatch`. Every later
`part` and `complete` must carry the recorded upload id (and `complete` the recorded bookmark) at the recorded state,
or it is refused as `ledger_mismatch`.

**The state** is the digest of the stretch, the DDL and both ledger tables. The **stretch** is the generation at which
the object entered its current uninterrupted run of `read-only`, `closed` and `inspect` (ADR-0069 §3): a transition
between those modes keeps it, `open` ends it, and a data step that writes while the object is restricted, which is
every import step but `verify` and a restore's `arm`, starts it again at the current generation before it writes. A
migration writes inside a stretch, but each of its writes lands in the ledger or the DDL. A dump therefore spans the
generations of one stretch, as Control's maintenance passes publish `read-only` again, and never yields a consistent
manifest across an `open`, a data step or a migration. The barrier keeps the stretch in R2 beside its state, at
`__fabrika/ops/<object>.frozen.json` with the generation it was written at, never in the state object, which an older
release parses strictly, and never in KV, which point-in-time recovery rewinds. A cold start resumes it only from a
record written at the published generation; otherwise the stretch starts at the published generation, which costs at
most one restarted dump. An object that holds an import marker is refused as `wrong_mode`. Each step of a consistent
dump runs in the barrier's turn (ADR-0069 §3), so no transition is acknowledged while a step reads. A cursor names a table, the last rowid read (as decimal text) and the count and hash folded so far: a
digest, never a value. The step code reads `sqlite_schema` and the tables directly. It needs neither the application's
boot nor the framework's tables, so it also dumps a database that cannot boot, or one restored to a time before those
tables existed. R2's lifecycle aborts an upload that never completes.

**Parts of one size.** Every part but the last is exactly one gzip member (RFC 1952) of exactly 8 MiB; the last is at
most that. The producer adds whole rows while all three bounds hold: the compressed member fits 8 MiB, its
uncompressed lines with their newlines stay within 16 MiB, and it holds at most 50 000 rows. It starts the next part
with the row that would break one, and pads the member to 8 MiB with spaces in its header's comment field (`FCOMMENT`).
A row that breaks a bound alone, in an empty part, is refused as `row_too_large`, naming the table. A row never spans
two parts, so the importer reads, checks and loads any part alone, by its byte range. The data object as a whole is a
multi-member gzip file that any gzip reader decompresses.

- **8 MiB** is above R2's minimum part and holds the largest row, its text and blobs as hex, uncompressed. 10 000 parts
  bound a dump at about 80 GB compressed, above the 10 GB an object holds.
- **16 MiB uncompressed** bounds an import step's memory. The compressed size alone does not: a thousand rows of
  repeated text compress far below 8 MiB and expand past a gigabyte. A naive step that holds every form of a part at
  once (compressed, decompressed, split into lines, parsed into values and bound as bytes) peaks near 90 MB, inside a
  Durable Object's 128 MB isolate. A 2 MB row is about 4 MB as hex, so the bound leaves room for the largest row.
- **50 000 rows** bounds an import step's CPU: one insert per row and one link update per deferred row. At tens of
  microseconds a row that is about a second, far below a request's CPU limit. 10 000 parts hold 500 million rows.
- The cost is padding: a part of small, compressible rows stops at the raw or the row bound with little compressed
  data, and is padded to 8 MiB.

**What a dump holds.** Every table of `sqlite_schema` but SQLite's internal ones and Cloudflare's `_cf_` tables. It
includes `sqlite_sequence`, so `AUTOINCREMENT` keeps its counter, and the migration ledger's two tables. A row is its
rowid, then every column that is not generated, in declaration order. A table is read in rowid order, which is its
keyset order.

**The keyset** is the name a step reads and writes the rowid by. It is the table's `INTEGER PRIMARY KEY` column when
it has one, which is the rowid itself: a rowid table whose primary key is one column of declared type `INTEGER` with no
automatic index (`PRAGMA index_list` origin `pk`; `INTEGER PRIMARY KEY DESC` gets one, and is no alias). Otherwise it
is the first of `rowid`, `_rowid_` and `oid` that no column takes, compared as SQLite compares identifiers. A table
with neither is refused: a column of that name may hold anything, duplicates included. An `INTEGER PRIMARY KEY` column
repeats the rowid in the row, and the importer writes it once.

**One schema rule.** `planOpsDump`, in the ops wire, takes the description the PRAGMAs give (`table_list`,
`table_xinfo`, `index_list`, `index_xinfo` and `foreign_key_list`, plus whether the table's SQL declares a `CHECK` or
an `INITIALLY DEFERRED` key, which no PRAGMA reports) and answers the plan or the refusal. The producer applies it at
export `begin` and the importer at import `begin`, so the two never disagree on the keyset, the load order or the
deferred columns.

**Load order.** Two tables share a **cycle** when each reaches the other through foreign-key parents; a table whose key
references itself is in a cycle of its own. The producer writes tables parents first: it repeatedly places the first
table by name all of whose parents outside its own cycle are placed. A foreign key whose parent lies in the child's own
cycle is **deferred** (§6): its columns are loaded `NULL` and set by the link pass. Every other key's parent rows are
loaded before its child's. The manifest lists the tables in this order, and the importer checks it against its own
plan; it never orders anything itself.

**Refused schemas.** `begin` refuses, as `unsupported_schema` naming the table (no table for a name the refusal may not
carry):

- a `WITHOUT ROWID` table, whose keyset would put key values, which are content, into Control's record; no primary key
  is accepted as its keyset;
- a virtual table, which the data layer does not read either;
- a table whose name breaks the data layer's identifier rule;
- a table without a keyset;
- a foreign key to a table outside the dump, one that names its parent's primary key implicitly when the parent has
  none, and one whose column counts differ;
- a foreign key that is `DEFERRABLE INITIALLY DEFERRED`: SQLite checks it at commit, which is the end of the request,
  so a violation would reset the object instead of failing its step (§6);
- a deferred column that cannot hold a temporary `NULL`: one that is `NOT NULL`, part of the primary key, or referenced
  by any foreign key as its parent key (two unique keys `a.k` and `b.k` referencing each other), or one in a table with
  a `CHECK`, a `NOT NULL` generated column, or a partial or expression unique index, any of which a temporary `NULL`
  may violate. A composite key in a cycle is therefore accepted only when every column of it is nullable and none is a
  referenced key.

An acyclic graph is always accepted, and so is a cycle of one table or several whose deferred columns are nullable,
unchecked and unreferenced.

### 3. Lossless values

Each column is projected in SQL as `(typeof(c), value)`:

| `typeof(c)` | Projected value        | Encoded as                                                                                 |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `integer`   | `cast(c as text)`      | `i:<decimal>`                                                                              |
| `real`      | `c`                    | `r:` and ECMAScript's shortest round-trip text of the double, keeping `-0` and `±Infinity` |
| `text`      | `hex(cast(c as blob))` | `t:<HEX>`, the bytes of the text in the database's encoding, UTF-8                         |
| `blob`      | `hex(c)`               | `b:<HEX>`                                                                                  |
| `null`      | `NULL`                 | `null`                                                                                     |

`opsDumpColumnProjection` writes this projection, and `readOpsDumpValue` reads it.

**A real crosses as the double itself.** workerd loses precision on int64 only; a double reaches JavaScript exactly,
and `Number.prototype.toString` writes the shortest text that reads back as the same double. `cast(real as text)` keeps
15 digits, and `printf` depends on how SQLite converts. SQLite never stores NaN.

**Text crosses as its bytes.** A JavaScript string cannot hold text that is not valid UTF-8, so text is read as the hex
of its bytes and tagged `t:`, apart from a blob's `b:`. The hash is computed over that form, so two texts that differ
in one byte hash differently.

**Values are written back in SQL, never through a JavaScript value that could change them** (`opsDumpValueBinding`):

| Value   | Bound as         | Written as           |
| ------- | ---------------- | -------------------- |
| integer | its decimal text | `CAST(? AS INTEGER)` |
| real    | the double       | `CAST(? AS REAL)`    |
| text    | its bytes        | `CAST(? AS TEXT)`    |
| blob    | its bytes        | `?`                  |
| null    | `null`           | `?`                  |

A rowid is an integer and is written the same way. The cast keeps the storage class in every column: decimal text bound
bare stays text in a column without affinity or a `STRICT` `ANY` one, and a binder may bind an integral double as an
integer. The column's affinity then applies exactly as it did when the source row was written.

**The canonical row encoding** is the `JSON.stringify` of the array of encoded values: no whitespace, NUL escaped,
characters outside the BMP written as they are. ECMAScript specifies `JSON.stringify`, so every runtime writes the same
text. A **line** of the dump is `{"table":"<name>","row":<row encoding>}`, and the data object is gzip-compressed
NDJSON.

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

- **Keys.** A consistent backup lies at `__fabrika/backups/<object>/<dump>/data.ndjson.gz`, `manifest.json` and
  `begun` in the environment's bucket, a diagnostic export under `__fabrika/exports/<object>/<dump>/`. The dump id is a UUIDv7 that
  Control generates. `__fabrika/` is reserved in the bucket, and the build refuses a file kind of that name (ADR-0069).
- **Retention.** A dump is kept 30 days. An R2 lifecycle rule on both prefixes, which the environment's deploy writes,
  expires it. Control lists only the backups its record holds, and never offers one older than 30 days for a restore.
  The deploy does not write the rule yet: oblaka's bucket resource has no lifecycle option, so until it has, a dump
  outlives its retention in the bucket (backlog 237).
- **Backup retention never exceeds the file tombstone window,** which is 30 days too. Removing a file queues its key,
  and the sweep deletes the bytes only once the key is past the window. A restored row keeps its file's original key,
  so the bytes are still there for any backup within its retention, and a restore cancels the queued deletion of every
  key its rows reference before the object opens.
- **Access** follows ADR-0069 §2: `data.read` lists backups; only `data.content.read` downloads a dump.

### 6. The importer

`POST /__fabrika/ops/import` loads a consistent backup into a fresh object, before boot. Control first publishes the
target `inspect` under the import operation's generation, and every step carries it. Every step runs in the barrier's
turn, holding it across its R2 reads, and is refused as `serving_object` on the object of ordinary traffic before it
reads anything.

1. **`begin`** reads the manifest and refuses it as `invalid_manifest` when it does not parse or is too large, and as
   `fuzzy_dump` when it is not consistent. It refuses a target that holds any table as `not_fresh`. It writes an import
   marker that names the backup into the target's KV storage, then applies the migrations up to the manifest's ledger:
   each bundle of the release must begin with exactly the manifest's files and checksums, files after them are not
   applied, and any difference is refused as `ledger_mismatch`. The resulting `sqlite_schema` must equal the manifest's
   DDL, and the schema rule's plan of it must list the manifest's tables in the manifest's order (`schema_mismatch`).
   It then clears the target, in one `transactionSync` that also records in the marker that `begin` is done:
   - it drops the triggers, so that no trigger fires on a removed or a loaded row;
   - it sets every deferred column of every table the manifest lists to `NULL`, which the schema rule guarantees each
     can hold;
   - it deletes every row of those tables in reverse load order, children before parents, so no foreign key is
     violated and no `ON DELETE` action reaches a row still there. The migrations' seed rows go, and so do
     `sqlite_sequence`'s, so a loaded row never collides with a seed, a seed the source deleted never survives, and an
     `AUTOINCREMENT` counter is the source's.

   The rows it deletes are the ones this release's migrations wrote into an empty database in the same step, so
   clearing costs no more than migrating did. It answers the number of parts. A `begin` retried on a target whose
   marker names the same backup resumes after what its marker records: it applies the migrations still missing and
   clears, or, once `begin` is done, answers again.
2. **`part`** _n_ reads the part by its byte range and refuses it as `part_mismatch` unless its size and SHA-256 match
   the manifest, and when it decompresses to more than 16 MiB or holds more than 50 000 rows; it stops decompressing
   at the bound. It inserts the rows with their rowids, by the keyset, in one `transactionSync`, which re-reads the marker
   and records the part's receipt in it, so a retried or overlapping part loads nothing twice. It writes every value through §3's bindings, and the
   columns of a deferred foreign key as `NULL`. The ledger's tables load like any other, so the restored ledger keeps
   its original times. It answers the rows it loaded and how many have a deferred key to set.
3. **`link`** _n_, once every part is loaded, sets the deferred keys of part _n_'s rows by their keyset, in one
   `transactionSync` that records its receipt. Control calls it only for the parts that reported deferred rows.
4. **`verify`** reads the tables back from a cursor with the producer's projection and fold, and compares each
   finished table's count and hash with the manifest (`verify_mismatch`, naming the table). It records in the marker
   the cursor it handed out, and the last step's cursor with its answer, so a step retried after a lost answer answers
   the same. Any other cursor, or a mismatch, clears that progress, and so does any later part or link.
5. **`complete`** refuses as `part_mismatch` unless every part and every needed link has its receipt, and as
   `verify_mismatch` unless a verification ran to its end since the last write. It recreates the triggers from the
   manifest's DDL, compares the whole schema again, clears the marker and keeps a completion receipt that names the
   backup, so a retried `complete` answers the same. Control may then publish the object `open`.

**`discard`** wipes a target with `deleteAll()`. The object accepts it only in `inspect`, holding an import marker, and
when it is not the object of ordinary traffic.

**Invariant: an object that holds an import marker never boots and never leaves `inspect`.** The barrier refuses a
transition out of `inspect` as `wrong_mode` while the marker exists, checked in its turn, and the object refuses
ordinary traffic, a boot and a migration while it holds one. A half-loaded clone can therefore never serve.

**Foreign keys are checked immediately.** A key the load order satisfies is checked as each row goes in. A deferred key
is written `NULL` and set by the link pass once every row is in, and that update is checked at once too: its parent row
is loaded, and the parent's key column is never deferred, so it holds its final value. A violation throws inside its
step's `transactionSync` and rolls back that step alone, so no violation can reach the end of a request and reset the
object. The schema rule refuses an `INITIALLY DEFERRED` key, the one kind SQLite checks only at commit.

### 7. Rehearsal

**A backup is verified by importing it.** Every scheduled backup is imported into the scratch object `rehearsal`
(`begin`, the parts, the links, `verify` to its end) and then wiped with `discard`; it sends no `complete`, which would
clear the marker `discard` requires. Control fences `rehearsal` in `inspect` at the backup operation's generation first. Every deploy at a gated release lists `rehearsal` in
`FABRIKA_APPLICATION_OBJECTS`, so the ops channel reaches it; ordinary traffic never does. A rehearsal that finds the
object not fresh, after an earlier one died, discards it first. A backup whose rehearsal fails is recorded as failed.
The verification of the migration phase (ADR-0069 §3) is this rehearsal.

### 8. Schedule

- **Daily.** Control's existing `*/5` cron starts a backup for each Cloudflare environment at a gated release that has
  a domain (ADR-0069 §1), has not opted out, and has no successful backup from the last day. The operation publishes
  `read-only`, waits for the acknowledgement, takes the consistent backup, opens the object at a new generation, and
  then rehearses. The rehearsal reads the stored backup, so it runs after the object reopened. A pass is bounded in
  time and in the backups it continues and starts, and a backup that does not finish continues in the next pass. The
  exporter binds a dump to the stretch of modes that write nothing its `begin` ran in (§2), which a pass that publishes
  `read-only` again at a new generation does not end, so the next pass continues the dump. A dump whose stretch ended
  starts again under a new dump id; the old upload is never completed, and the bucket's lifecycle expires it. Control records a backup's outcome in the same write as its operation's next step. An hour after
  a failed backup ended the environment is due again. A backup starts only from the schedule and only while Control's
  record leaves the object `open`.
- **Before a migration.** A deploy that brings a pending application migration to an environment at a gated release
  runs as one operation under the deploy lease: `read-only`, the backup, its rehearsal, the operation's own deploy, the
  migration request, then `open` at a new generation. A failed backup or rehearsal reopens the object and does not
  deploy. A migration is pending when one of the candidate's application migration files is missing from the object's
  ledger, which Control reads with `inspect`; the published snapshot proves nothing, because a published file has not
  run while its version never booted. The rule applies once the version running installed the ops channel, which
  Control knows from the last succeeded deploy, not from the latest publication: a publication precedes the provider,
  and a run that failed after it changed nothing that runs. A version without the channel (an older release, or a gated
  one deployed without a domain) gets a plain deploy, and the object migrates on its cold start. An object whose
  installed channel does not answer gets no deploy. The operation's deploy is the run's own. A deploy or a migration
  that fails leaves the object restricted, for a recovery.
- **Opting out** stops the daily backup only. The pre-migration backup belongs to the migration phase and always runs.
- An environment on an older release gets no backups, and the console says so.

### 9. Side restore

The one flow built for "the data as it was at time T". Everything runs as one Control operation `<op>`, under the
environment's deploy lease and `data.manage`. Starting it only records it, with its target time and original, in one
write; Control's maintenance pass owns it and drives it a bounded stretch at a time, so no request's lifetime bounds it.

1. **List the clone.** The operation's own deploy adds `application-<op>` to `FABRIKA_APPLICATION_OBJECTS` and leaves
   `FABRIKA_APPLICATION_OBJECT` as it is. The ops channel reaches only a listed object (ADR-0069 §1), and listing it
   before the freeze keeps a deploy out of the read-only window. The operation is refused when the list already holds
   16 names. Control then inspects the clone: an answer proves the deployed version lists it, and a refusal, from a
   runner that does not forward the pointer, fails the operation before anything is frozen.
2. **Freeze** the serving object: `read-only`, then the acknowledged drain.
3. **Back up** consistently, and rehearse the backup.
4. **Import** the backup into `application-<op>`, published `inspect`, and verify it.
5. **Make the clone authoritative.** Publish the clone `open` and the original `inspect`, so the original never boots
   again. The operation's pointer deploy then writes `FABRIKA_APPLICATION_OBJECT=application-<op>` and keeps both names
   in `FABRIKA_APPLICATION_OBJECTS`. The clone boots, finds an equal ledger, repairs its scheduler and serves. Before
   anything is rewound Control confirms it. First `prepare` on the original: it is refused as `serving_object` while
   the deployed version still sends traffic there, and that refusal alone points traffic back, which loses nothing,
   since the clone served no ordinary request. Then `migrate` on the clone, which answers only once it booted, and only
   while it is published in a mode other than `inspect`. A view without a boot failure proves nothing, since `inspect`
   never boots. Nor does a view with one, or a lost answer: the failure lives in one instance's memory, and an earlier
   instance may have booted and served writes. So once traffic moved, nothing points it back, and the operation waits
   for the clone's boot.
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

**The pointer lives in Control.** Control records each environment's serving object and object list
(`app_env_application_objects`), and every deploy of a release that serves the ops channel writes them as
`FABRIKA_APPLICATION_OBJECT(S)`, so an ordinary deploy after a restore keeps traffic on the clone. Only a restore's own
deploys move the record, in the same write as the operation's next step. An environment without one gets the defaults,
`application` and `application,rehearsal`. A recovery that opens past a restore, also through a recovery of an
interrupted recovery, keeps the object that may hold writes, and only where traffic goes. The clone, once a provider
accepted the pointer deploy, nothing showed the clone served no request, and `prepare` proves the pointer moved off the
original (or `serve` recorded that it did). It does not wait for the clone's boot: once the clone is `open` and the
original `inspect`, the environment is open on a broken deploy, which an ordinary deploy of a fixed version repairs.
Only the rewind needs the boot answer. Otherwise the original, pointed back first. While a restore's deploy has no
outcome, or an answer is unclear, the recovery waits.

**Invariant: point-in-time recovery never touches the object of ordinary traffic.** The object refuses `prepare` and
`arm` as `serving_object` while it is `FABRIKA_APPLICATION_OBJECT`, and as `wrong_mode` unless it is `inspect`.

| Failure                                          | Outcome                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Control dies mid-operation                       | The next maintenance pass fences each object at its step's mode and resumes from the recorded step       |
| The listing deploy fails                         | Nothing is frozen; the operation fails and the environment is as before                                  |
| The backup or its rehearsal fails                | The original reopens at a new generation; the operation fails                                            |
| The import into the clone fails                  | The clone is discarded and the original reopens; the operation fails: a retry of that backup would too   |
| The pointer deploy fails                         | Not accepted: the original opens again, the clone `inspect`. Accepted: the confirmation decides          |
| The clone does not boot after the pointer deploy | Traffic stays, nothing is rewound; an `open` recovery settles on the clone, a fixed deploy repairs it    |
| Traffic did not move after the pointer deploy    | `prepare` is refused as `serving_object`; the same deploy back, and the original opens                   |
| T lies outside the recovery window               | `prepare` is refused as `bookmark_unavailable`; the clone keeps serving; nothing is lost                 |
| The answer to `arm` is lost                      | `verify` decides: an absent sentinel is a restore; a present one arms again                              |
| The object did not reset after `arm`             | `verify` finds the sentinel; the operation arms again, three times at most, then fails; the clone serves |
| The rewound original shows an unexpected schema  | It stays `inspect`; the clone keeps serving; an operator investigates                                    |
| A write arrives during the window                | Fenced by generation (ADR-0069 §3); a webhook gets 503 and retries                                       |
| Two objects in one isolate                       | Per-object runtime state keeps them apart; the original is `inspect` and never boots                     |
| The files bucket is shared                       | The original runs no sweep; the tombstones keep the bytes its rows at T reference, for the window        |
| The original keeps billing storage               | Until it is deleted                                                                                      |

**Not built: an in-place restore and a whole-environment rollback.** Rewinding the serving object, exporting, and
restoring forward rests on the forward restore succeeding, which is unprobed, and an undo bookmark lost in transit has
no recovery. Both wait until probe 7 has exercised every failure boundary on a live account.

### 10. The timers view

`POST /__fabrika/ops/timers` reads the pending-work tracker (ADR-0069 §2): every live timer and `waitUntil` promise of
the isolate, with the stack that registered it, oldest first, at most 500 and the count of the rest. `track` switches
the tracker on or off first. Its scope is the isolate, not the object named: global timers belong to no object, so
every object the isolate hosts shares the switch and the records, and a request naming one object reads and switches
them for all. It lives in memory, and only the isolate's eviction resets it; the next isolate's tracker is off. Each
stack is scrubbed of credential shapes and bounded in frames and bytes. It is diagnostics: it writes nothing and
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
the table's name. Every answer is parsed by the wire's strict parser. Every reader of a manifest, a complete answer
included, refuses one whose `JSON.stringify` exceeds 4 MiB in UTF-8.

## Consequences

- A Cloudflare environment has a daily backup that was restored once before it counts, and recovering old data never
  rewinds the data that serves.
- Each daily backup puts the environment in `read-only` for as long as the export takes: seconds for the tens of MB
  typical of an internal application, unmeasured until a live run.
- An environment's bucket holds 30 daily backups and the pre-migration ones. Every part but the last takes 8 MiB, so a
  dump of small, compressible rows is mostly padding.
- A schema the rule refuses (§2) cannot be backed up: a `WITHOUT ROWID` or virtual table, a table whose rowid no name
  reads, an `INITIALLY DEFERRED` foreign key, or a cycle of foreign keys whose columns cannot be `NULL` for a while.
  `begin` names the table, and the console shows it.
- Text survives byte for byte, valid UTF-8 or not; as hex it doubles in size before compression.
- No trigger fires while a backup loads; the importer drops the triggers and recreates them from the manifest.
- A side restore makes the service unavailable from the moment the original turns `inspect` until the pointer deploy
  completes. It adds one name to `FABRIKA_APPLICATION_OBJECTS` until the original is deleted, and the list holds 16.
- The dump format is versioned, and a reader refuses a format it does not know. A change to the encoding or the hash is
  a new format.
- What only a live account shows is built against the probes' dry runs and unconfirmed: point-in-time recovery and its
  reset, R2's multipart limits, workerd decompressing a member with a large header comment, and the bookmark format.
- On Zerops an application has no object, and nothing changes.
- **Rollout.** Backups, the migration phase and the side restore ship in framework 0.9.0, gated by
  `servesDataOperations`, which holds from `0.9.0-dev.5`: the 0.9.0 prereleases published before it serve the channel's
  `inspect` but not `state` or `migrate`, so their environments keep plain deploys and get no backup (ADR-0062).
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
- **Text as a JavaScript string.** Half the size of hex. Rejected: text that is not valid UTF-8 reads as replacement
  characters, two different values become one, and the hash cannot see it.
- **Bounding a part by its compressed size alone.** Fewer, fuller parts. Rejected: compressible rows expand without
  bound in the step that loads them.
- **`defer_foreign_keys` for self-referencing keys.** Rejected: deferral ends with the request, and a table spans many
  steps, so a row whose parent lies in a later part fails at the request's end and resets the object. The link pass
  sets such keys once every row is in.
- **A keyset over the primary key**, so that `WITHOUT ROWID` tables could be dumped. Rejected: the cursor in Control's
  record would hold key values, which are content.
- **Moving deleted files to a prefix.** Rejected: a restored row keeps its file's original key, which would no longer
  hold the bytes. Deletions are tombstoned for the retention window instead.
- **In-place point-in-time recovery.** One object and no pointer deploy. Rejected for now: it rewinds the only database
  that serves, and its safety rests on an unprobed forward restore (§9).
