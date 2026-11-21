---
id: 0078
title: A repeated request is answered from its receipt
status: accepted
date: 2026-11-21
---

# 0078 — A repeated request is answered from its receipt

## Context

A dialog that writes may lose its answer: the connection drops after the commit, a phone goes to sleep, a proxy
times out. The client cannot tell a write that happened from one that did not, so it sends the request again. Without
help from the platform the second request writes a second time, or the handler has to recognise it.

A large application on fabrika recognises it by hand. It sends a `requestId` with each mutation of a dialog, stores it
in a `request_id` column of the table the mutation writes, and looks it up before writing: about 160 lookups, about
130 replay branches and 125 such columns. Each branch has the same problems:

- a row the mutation wrote can be hidden from the same action afterwards (a policy's `when` stops matching once the
  row is closed), so the replay does not find it and answers 404 or 409 although the write happened;
- a table without the column needs a migration before its mutation can replay;
- a file in the input cannot be compared: the handler never sees its bytes;
- every operation needs its own replay tests.

The application then designed one table of receipts for the whole application, written in the mutation's transaction,
with the answer stored in it. Its rules are the requirements of this decision: authorization runs before a stored
answer is returned; the identity is per operation (the request key and the operation's input), and a different input
under the same key is refused; the answer is stored in the same transaction as the business write; a stored answer the
current output schema would change is refused, and the work does not run; receipts are swept after a retention period.
Nothing in an application can meet these rules as well as the dispatcher: only the dispatcher sees the request before
the handler, the parsed input, the file digests, the validated output and the transaction's commit.

## Decision

The dispatcher answers a repeated mutation from a receipt it stored when the first request committed.

1. **The key.** A client marks a request repeatable with an `Idempotency-Key` header (the IETF HTTP API working group's
   name), one value per user action: a new one for every new submission, the same one for every retry of it. The value
   is 1–128 characters of `A–Z a–z 0–9 . _ ~ : -`, bare or as a quoted string. Anything else is a 400
   (`request_key_invalid`). The typed client sends it from `api.<procedure>(input, { requestKey })`.
2. **Where it is accepted.** On a credentialed staged-kit mutation that answers JSON. A query, a read-only procedure, a
   procedure without a data site, a procedure that answers a file, an attachment or a redirect, and a public procedure
   (whose caller is a visitor, not a principal) refuse a request that carries the header with a 400
   (`request_key_not_accepted`): a client must never believe a request is protected when it is not.
3. **Authorization first.** The receipt is read after every check that refuses the request before its handler: the
   proxy's decision, the token, caller kind and requirement, admission, the access form (`on`, `in`, `creates`, `app`,
   capabilities) and the caller's own row (`ctx.caller`, when the contract declares it). A caller refused there gets
   the refusal, never a stored answer. A check the handler makes itself (`.require`, `can()`) does not run on a replay:
   the receipt holds an answer this principal already received.
4. **The identity.** A receipt is keyed by the principal (the token's subject) and the key. It records the operation
   (the endpoint id) and the SHA-256 of the request's canonical input: the input as parsed and its signed tokens
   verified, with the procedure's `query`, object keys sorted, array order kept; a file of the input is its kind, type,
   size and the SHA-256 of its bytes, which the upload computed, never its pending id. The same key with another
   operation or another identity is a 409 (`request_key_reused`); nothing runs. Another principal's key never meets
   this one: it is a new request.
5. **Recorded in the transaction.** When there is no receipt, the handler runs. After its output passed validation the
   dispatcher writes the receipt (the output's JSON, at most 64 KiB in UTF-8) in the invocation's transaction, before
   its commit. A handler that throws, an output refused, a cancelled request or a failed commit leaves no receipt, so
   the retry runs the work again. An output over the limit fails the request with a 500
   (`request_receipt_too_large`): the procedure answers too much to replay. A receipt the same key wrote meanwhile (two
   copies of the request at once) makes the later one a 409 (`request_key_concurrent`), and its transaction rolls back;
   its retry reads the receipt.
6. **The replay.** A receipt of the same operation and identity is answered as the first request was, `200` with
   `{ result }`, without running the handler, recording kicks or writing anything. Its stored output is run through
   the endpoint's current output projection and schema first. When the schema refuses it, or would change it (drop a
   field, fill a default, transform a value), the answer is a 409 (`request_replay_incompatible`): the client reads the
   state again. It is never taken for a missing receipt, so the work never runs a second time.
7. **Retention.** A receipt is kept at least 7 days. Each receipt write deletes a bounded batch of receipts older than
   that, as an admission take prunes its buckets, so the table holds about a week of keyed writes. A receipt that
   still exists answers, however old.
8. **Storage.** One framework table, `fabrika_request_receipts`, in both framework migration bundles (Postgres and
   SQLite). An application cannot reach it: `ctx.sql` refuses every `fabrika_*` name, and no store or handle reads it.

## Consequences

- An application writes a mutation as if it runs once. It needs no `request_id` column, no replay branch and no
  per-operation replay test; a row its `when` hides after the write does not matter, because the replay reads no
  business row. An operation whose effect depends on something other than its input and its caller (a counter the
  server derives, a deduplication rule of the business) keeps its own rule: that is business logic, not a replay.
- The client owns the key's lifetime: it creates a new key for each submission and keeps it across retries, including
  when the user changes a file and submits again (a new submission, a new key). With the file's digest in the
  identity, a different file under the same key is refused, not taken for the same request.
- Stored answers outlive deploys. A changed output schema answers 409 for old receipts it would change; a changed input
  schema that parses the same bytes differently gives another identity, so the old key answers 409, never a second
  write. Neither needs an operation version.
- The stored output may carry personal data the caller saw. Only the dispatcher reads it, for the same principal, and
  the sweep removes it after the retention; backups keep their own retention. In an environment that stops taking keyed
  writes, the last week's receipts stay until the next one.
- A browser page on another origin cannot send the header yet: the proxy's preflight admits `Authorization` and
  `Content-Type` only. Same-origin pages and server callers can.
- The header and the table are framework API, not platform protocol: an application gets them when it raises its pin,
  and an older framework release ignores the header. The framework migration adds the table on the application's next
  deploy; an existing installation needs no step.
- The receipt costs one indexed read on every keyed request and one insert with a bounded delete on every keyed write.

## Alternatives considered

- **A `request_id` column per table, looked up by the handler.** What the application does today: a migration per
  table, a branch per operation, and a row its `when` hides is not found again. Rejected.
- **The receipt in the application, behind a helper.** An application can write one. Every mutation
  must call it in the right place, after authorization and before any state check, and the application cannot see a
  file's digest or the validated output after projection. The dispatcher sees all of them, once for every application.
- **A receipt that points at the result row instead of storing the output.** The replay would read the row, which is
  what a `when` prevents.
- **The key in the input.** It would be part of the input schema of every procedure, and of its identity. A header is
  outside both, and the IETF draft names it.
- **A key unique across principals.** A stranger's key would answer 409 instead of being a new request, which ties
  together people who share nothing.
- **A failed read of the receipt taken as no receipt.** It would run a write that already happened. Every failure of
  the receipt read fails the request.
- **A daily framework job for the sweep.** It deletes old receipts on time even when nothing writes, but it adds a
  scheduled job to every application with a database, on both runtimes. The bounded delete on write keeps the table
  bounded without one, as the admission buckets do.
