import { type DeployLocks, type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import { ProviderInvocationAbort } from '@fabrika/provider-contract'
import { expect, test } from 'bun:test'
import { createControlRepositories } from '../../db'
import { acquireLease, LEASE_RENEW_MS, LEASE_TTL_MS, type LeaseClock, runLeaseKey } from '../../lease'

/** A fake clock shared by the lease and the lock store: `advance` wakes due sleepers, nothing waits in real time. */
export class ManualClock implements LeaseClock {
	value = 1_000_000
	private readonly sleepers = new Set<{ at: number; wake(): void }>()
	now = (): number => this.value
	wait = (ms: number, signal: AbortSignal): Promise<void> =>
		new Promise((resolve, reject) => {
			signal.throwIfAborted()
			const abort = (): void => {
				this.sleepers.delete(entry)
				reject(signal.reason)
			}
			const entry = {
				at: this.value + ms,
				wake: () => {
					signal.removeEventListener('abort', abort)
					resolve()
				},
			}
			this.sleepers.add(entry)
			signal.addEventListener('abort', abort, { once: true })
		})
	async advance(ms: number, settle: () => Promise<void> = flush): Promise<void> {
		this.value += ms
		for (const entry of this.sleepers) {
			if (entry.at <= this.value) {
				this.sleepers.delete(entry)
				entry.wake()
			}
		}
		await settle()
	}
}

export async function flush(): Promise<void> {
	for (let i = 0; i < 40; i++) await Promise.resolve()
}

/** The production store with a switchable renew, recording when each renewal was asked for. */
export class RecordingLocks implements DeployLocks {
	readonly renewedAt: number[] = []
	renewal: 'live' | 'refused' | 'error' | 'hanging' = 'live'
	private readonly inflight = new Set<Promise<unknown>>()

	constructor(private readonly inner: DeployLocks, private readonly clock: ManualClock) {}

	acquire(key: string, holder: string, ttlMs: number): Promise<boolean> {
		return this.inner.acquire(key, holder, ttlMs)
	}

	release(key: string, holder: string): Promise<void> {
		return this.inner.release(key, holder)
	}

	renew(key: string, holder: string, ttlMs: number): Promise<boolean> {
		this.renewedAt.push(this.clock.now())
		if (this.renewal === 'refused') return Promise.resolve(false)
		if (this.renewal === 'error') return Promise.reject(new Error('offline'))
		if (this.renewal === 'hanging') return new Promise(() => {})
		const renewing = this.inner.renew(key, holder, ttlMs)
		this.inflight.add(renewing)
		void renewing.finally(() => this.inflight.delete(renewing))
		return renewing
	}

	/** Wait for every renewal the store is answering, then let the lease loop take its next step. */
	readonly idle = async (): Promise<void> => {
		await flush()
		while (this.inflight.size > 0) {
			await Promise.allSettled([...this.inflight])
			await flush()
		}
	}
}

export function leaseContract(database: () => SqlDatabase): void {
	async function fixture(appId: string) {
		const sql = database()
		const clock = new ManualClock()
		const locks = new RecordingLocks(new SqlDeployLocks(sql, { now: clock.now }), clock)
		const advance = (ms: number) => clock.advance(ms, locks.idle)
		return { sql, clock, locks, advance, key: runLeaseKey(appId, 'prod') }
	}

	test('two holders race for one key and exactly one wins', async () => {
		const { clock, locks, key } = await fixture('race')
		const leases = await Promise.all([acquireLease(locks, key, clock), acquireLease(locks, key, clock)])
		expect(leases.filter((lease) => lease !== null)).toHaveLength(1)
		await Promise.all(leases.map((lease) => lease?.release()))
		const next = await acquireLease(locks, key, clock)
		expect(next).not.toBeNull()
		await next?.release()
	})

	test('renewal keeps exclusion past one TTL', async () => {
		const { clock, locks, advance, key } = await fixture('renewal')
		const start = clock.now()
		const lease = await acquireLease(locks, key, clock)
		if (lease === null) throw new Error('lease missing')
		for (let period = 0; period < 4; period++) await advance(LEASE_RENEW_MS)
		expect(clock.now() - start).toBeGreaterThan(LEASE_TTL_MS)
		expect(locks.renewedAt).toEqual([1, 2, 3, 4].map((period) => start + period * LEASE_RENEW_MS))
		expect(lease.signal.aborted).toBe(false)
		expect(lease.fence()).toMatchObject({ nowMs: clock.now() })
		expect(await acquireLease(locks, key, clock)).toBeNull()
		await lease.release()
		expect(lease.signal.reason).toBeInstanceOf(ProviderInvocationAbort)
		expect(await acquireLease(locks, key, clock)).not.toBeNull()
	})

	test("a dead holder's key is re-acquirable within one TTL plus one renew period", async () => {
		const { clock, locks, advance, key } = await fixture('dead-holder')
		const lease = await acquireLease(locks, key, clock)
		if (lease === null) throw new Error('lease missing')
		await advance(LEASE_RENEW_MS)
		const lastRenewal = clock.now()
		// The process dies just before its next renewal: nothing renews and nothing releases.
		locks.renewal = 'hanging'
		await advance(LEASE_RENEW_MS - 1)
		const died = clock.now()
		await advance(lastRenewal + LEASE_TTL_MS - 1 - clock.now())
		expect(await acquireLease(locks, key, clock)).toBeNull()
		await advance(1)
		const next = await acquireLease(locks, key, clock)
		expect(next).not.toBeNull()
		expect(clock.now() - died).toBeLessThanOrEqual(LEASE_TTL_MS + LEASE_RENEW_MS)
		await lease.release()
		expect(await acquireLease(locks, key, clock)).toBeNull()
		await next?.release()
	})

	for (const renewal of ['refused', 'error', 'hanging'] as const) {
		test(`a ${renewal} renewal aborts with lease_lost and a stale fenced write matches no row`, async () => {
			const { sql, clock, locks, advance, key } = await fixture(`lost-${renewal}`)
			const repositories = createControlRepositories(sql)
			const appId = `lost-${renewal}`
			await repositories.registry.createApp({ id: appId, repoUrl: 'github.com/acme/app' })
			await repositories.registry.upsertAppEnv({
				appId,
				env: 'prod',
				namespaceId: null,
				provider: 'test',
				providerTargetJson: '{}',
				providerArtifactJson: '{}',
			})
			await repositories.runs.createRun({ id: appId, appId, env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
			const lease = await acquireLease(locks, key, clock)
			if (lease === null) throw new Error('lease missing')
			const staleFence = lease.fence()
			expect(await repositories.runs.markRunStarted(appId, 'logs', staleFence)).toBe(true)
			locks.renewal = renewal
			await advance(LEASE_RENEW_MS)
			if (renewal === 'hanging') {
				expect(lease.signal.aborted).toBe(false)
				await advance(LEASE_TTL_MS - LEASE_RENEW_MS)
			}
			expect(lease.signal.aborted).toBe(true)
			expect(lease.signal.reason).toBeInstanceOf(ProviderInvocationAbort)
			expect(Reflect.get(lease.signal.reason, 'kind')).toBe('lease_lost')
			expect(() => lease.fence()).toThrow(ProviderInvocationAbort)
			await advance(LEASE_TTL_MS)
			locks.renewal = 'live'
			const takeover = await acquireLease(locks, key, clock)
			if (takeover === null) throw new Error('takeover missing')
			expect(await repositories.runs.markRunFinished(appId, 'failed', null, { ...staleFence, nowMs: clock.now() })).toBe(false)
			expect((await repositories.runs.getRun(appId))?.status).toBe('running')
			expect(await repositories.runs.markRunFinished(appId, 'succeeded', 0, takeover.fence())).toBe(true)
			await lease.release()
			expect(await acquireLease(locks, key, clock)).toBeNull()
			await takeover.release()
		})
	}

	test('a write that matched no row aborts the lease', async () => {
		const { clock, locks, key } = await fixture('unwritten')
		const lease = await acquireLease(locks, key, clock)
		if (lease === null) throw new Error('lease missing')
		lease.assertWritten(true)
		expect(lease.signal.aborted).toBe(false)
		expect(() => lease.assertWritten(false)).toThrow(ProviderInvocationAbort)
		expect(lease.signal.aborted).toBe(true)
		expect(() => lease.fence()).toThrow(ProviderInvocationAbort)
		await lease.release()
	})
}
