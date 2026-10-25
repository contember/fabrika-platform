# An in-handler upload leaves bytes after an eviction

On Cloudflare, a `ctx.files.put` inside a writing handler stages its pending row inside the handler's enclosing
storage transaction: a Durable Object joins every write made while that transaction is open, so no write can commit on
its own before the first byte. When the maintenance fence rolls the handler back, the framework releases the staged
files at once; when the object is evicted before that release, the bytes stay in the environment's bucket with no row
and no intent, and the sweep cannot find them. Unfinished multipart uploads after an eviction have the same gap: the
Workers R2 binding cannot list them. The cost is storage only; the key is random and no row references it.

ADR-0069 §3 records the gap. A request's multipart files are not affected: they are staged before the handler's
transaction opens.

## Fix idea

Write an intent object under the reserved `__fabrika/` prefix in R2 before the first byte (outside the storage
transaction), name the object key in it, and let the sweep list the prefix and remove each intent whose key no row
references once the grace and the retention window passed. Needs a `list` on the `FileObjectStore` port
(`packages/platform/src/ports.ts`) and its R2 implementation (`packages/app/src/cloudflare/r2-files.ts`).

## Done when

A test evicts the object after an in-handler put rolled back without its release, reopens it, and the sweep removes the
bytes; a committed put's object stays.
