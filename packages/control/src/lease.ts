import { type DeployLocks, uuidv7 } from '@fabrika/platform'
import { abortableWait, ProviderInvocationAbort } from '@fabrika/provider-contract'

/** How long a dead holder blocks its key (ADR-0044). */
export const LEASE_TTL_MS = 90_000
export const LEASE_RENEW_MS = 30_000

export interface LeaseClock {
	now(): number
	wait(ms: number, signal: AbortSignal): Promise<void>
}

/** One holder-checked SQL write; the statement derives the lease key from the row it writes. */
export interface LeaseFence {
	readonly holder: string
	readonly nowMs: number
}

export interface Lease {
	readonly key: string
	/** Aborts once with `lease_lost`: on renew failure or timeout, the local deadline, `abandon()`, or release. */
	readonly signal: AbortSignal
	/** Throws `lease_lost` unless the lease is still held. */
	assertHeld(): void
	/** A fresh fence for one SQL write; throws `lease_lost` unless held. */
	fence(): LeaseFence
	/** A fenced write matched 0 rows: abandon the lease and throw `lease_lost`. */
	assertWritten(changed: boolean): void
	/** Stop acting as the holder without releasing the row, e.g. after a write whose outcome is unknown. */
	abandon(): void
	release(): Promise<void>
}

export const runLeaseKey = (appId: string, env: string): string => `${appId}:${env}`
export const namespaceLeaseKey = (namespaceId: string): string => `namespace:${namespaceId}`
export const CATALOG_LEASE_KEY = 'operations-catalog-projection'

const systemClock: LeaseClock = { now: Date.now, wait: abortableWait }

/** Take `key` for one invocation, or `null` while another holder's lease is live. */
export async function acquireLease(store: DeployLocks, key: string, clock: LeaseClock = systemClock): Promise<Lease | null> {
	const holder = uuidv7()
	const acquiredAt = clock.now()
	if (!(await store.acquire(key, holder, LEASE_TTL_MS))) return null
	return new HeldLease(store, key, holder, clock, acquiredAt)
}

/**
 * Take every key in `keys`, in sorted order so two callers never wait on each other, or none: `null` while any is live
 * elsewhere, with what was taken released. The answer is one lease fenced on `fenceKey`, one of `keys`, whose signal
 * aborts once any of them is lost and whose release frees them all.
 */
export async function acquireLeases(
	store: DeployLocks,
	keys: readonly string[],
	fenceKey: string,
	clock: LeaseClock = systemClock,
): Promise<Lease | null> {
	if (!keys.includes(fenceKey)) throw new Error(`the fence key ${fenceKey} is not among the keys taken`)
	const held: Lease[] = []
	for (const key of [...new Set(keys)].sort()) {
		const lease = await acquireLease(store, key, clock)
		if (lease === null) {
			await Promise.all(held.map((taken) => taken.release()))
			return null
		}
		held.push(lease)
	}
	const fence = held.find((lease) => lease.key === fenceKey)
	if (fence === undefined) throw new Error(`the fence key ${fenceKey} is not among the keys taken`)
	return new LeaseSet(fence, held)
}

class LeaseSet implements Lease {
	readonly signal: AbortSignal

	constructor(private readonly fenced: Lease, private readonly held: readonly Lease[]) {
		this.signal = AbortSignal.any(held.map((lease) => lease.signal))
	}

	get key(): string {
		return this.fenced.key
	}

	assertHeld(): void {
		for (const lease of this.held) lease.assertHeld()
	}

	fence(): LeaseFence {
		this.assertHeld()
		return this.fenced.fence()
	}

	assertWritten(changed: boolean): void {
		if (changed) return
		this.abandon()
		throw new ProviderInvocationAbort('lease_lost')
	}

	abandon(): void {
		for (const lease of this.held) lease.abandon()
	}

	async release(): Promise<void> {
		await Promise.all(this.held.map((lease) => lease.release()))
	}
}

// The local deadline ends one renew period before the stored expiry, so a holder stops before a takeover can start.
const LOCAL_TTL_MS = LEASE_TTL_MS - LEASE_RENEW_MS

class HeldLease implements Lease {
	private readonly controller = new AbortController()
	private readonly renewal: Promise<void>
	private deadline: number

	constructor(
		private readonly store: DeployLocks,
		readonly key: string,
		private readonly holder: string,
		private readonly clock: LeaseClock,
		acquiredAt: number,
	) {
		this.deadline = acquiredAt + LOCAL_TTL_MS
		this.renewal = this.renewLoop()
	}

	get signal(): AbortSignal {
		return this.controller.signal
	}

	assertHeld(): void {
		if (this.clock.now() >= this.deadline) this.abandon()
		if (this.signal.aborted) throw new ProviderInvocationAbort('lease_lost')
	}

	fence(): LeaseFence {
		this.assertHeld()
		return { holder: this.holder, nowMs: this.clock.now() }
	}

	assertWritten(changed: boolean): void {
		if (changed) return
		this.abandon()
		throw new ProviderInvocationAbort('lease_lost')
	}

	abandon(): void {
		if (!this.signal.aborted) this.controller.abort(new ProviderInvocationAbort('lease_lost'))
	}

	async release(): Promise<void> {
		this.abandon()
		await this.renewal
		await this.store.release(this.key, this.holder)
	}

	private async renewLoop(): Promise<void> {
		try {
			while (!this.signal.aborted) {
				await this.clock.wait(LEASE_RENEW_MS, this.signal)
				const started = this.clock.now()
				if (started >= this.deadline) break
				const timeout = new AbortController()
				const renewed = await Promise.race([
					this.store.renew(this.key, this.holder, LEASE_TTL_MS),
					this.clock.wait(this.deadline - started, AbortSignal.any([this.signal, timeout.signal])).then(() => false),
				]).finally(() => timeout.abort())
				if (!renewed) break
				this.deadline = started + LOCAL_TTL_MS
			}
		} catch {
			// A failed renewal and a release both end here; either way the lease is gone.
		}
		this.abandon()
	}
}
