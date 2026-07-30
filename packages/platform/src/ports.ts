// The remaining platform ports. Each one names a capability the control plane needs, in the
// narrowest form the code actually uses — not the full surface of whatever Cloudflare primitive
// happens to provide it today. Widening a port is a decision; keep them boring.
//
// UNLIKE `SqlDatabase`, these are NOT satisfied structurally by the Cloudflare bindings, and no
// amount of wishing makes them so: `R2Bucket.put` resolves to `R2Object | null` and `Queue.send` to
// `QueueSendResponse`, neither of which is assignable to `Promise<void>`. The Cloudflare side wraps
// them in await-and-discard adapters (`packages/control/src/platform-cf.ts`). That is the correct
// shape — a port should describe what callers need, not inherit a vendor's return values — but it
// does mean adopting one of these ports costs a small adapter rather than nothing.

/** Bytes written to blob storage (run logs). Both R2 and S3/MinIO satisfy this. */
export interface BlobStore {
	put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<void>
	get(key: string): Promise<{ body: ReadableStream; text(): Promise<string> } | null>
	delete(key: string): Promise<void>
}

/** Enqueue a deploy job. The CONSUMER side is platform-specific and deliberately not modelled here. */
export interface JobQueue<T> {
	send(message: T, options?: { delaySeconds?: number }): Promise<void>
}

/**
 * Per-target mutual exclusion, keyed by `<app>:<env>`. Matches the seam the control plane already
 * had around its Durable Object, so swapping the implementation touches no call site.
 *
 * Contract, unchanged from the DO it replaces:
 *  - NON-REENTRANT — a live lease returns false even to the same holder, so a redelivered message
 *    defers rather than double-running.
 *  - TTL-BOUNDED — a consumer that dies mid-deploy self-heals when the lease expires, instead of
 *    wedging that app-env forever.
 *  - HOLDER-CHECKED release — a late release from a superseded run can never free a lease that a
 *    newer run has since taken.
 *
 * The database-backed implementation expresses all three as one conditional UPDATE, which is atomic
 * on SQLite and Postgres alike — so this port has ONE implementation on every platform.
 */
export interface DeployLocks {
	/** Take the lease for `key`. `true` when acquired (free or expired), `false` when live elsewhere. */
	acquire(key: string, holder: string, ttlMs: number): Promise<boolean>
	/** Release the lease iff `holder` still owns it. Idempotent; a stale holder's call is a no-op. */
	release(key: string, holder: string): Promise<void>
}

/** One HTTP-speaking service behind a platform-native or network transport. */
export interface HttpService {
	fetch(request: Request): Promise<Response>
}

/** Serves the built SPA for non-API paths. */
export interface AssetServer extends HttpService {}

/**
 * Keep work alive past the response. On Workers this is `ctx.waitUntil`; in a long-running process
 * it is a supervised background promise. Implementations MUST swallow-and-log rejections — a
 * background failure must never take the process down.
 */
export type WaitUntil = (promise: Promise<unknown>) => void
