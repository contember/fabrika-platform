import { SqlDeployLocks } from '@fabrika/platform'
import { ProviderInvocationAbort } from '@fabrika/provider-contract'
import { expect, test } from 'bun:test'
import { acquireLease, LEASE_RENEW_MS, LEASE_TTL_MS, namespaceLeaseKey } from '../lease'
import { createHarness } from './helpers/harness'
import { ManualClock, RecordingLocks } from './helpers/lease'

async function fixture() {
	const harness = createHarness()
	const clock = new ManualClock()
	const locks = new RecordingLocks(new SqlDeployLocks(harness.d1, { now: clock.now }), clock)
	const row = await harness.db.registry.createDeploymentNamespace({
		id: 'ns',
		env: 'prod',
		provider: 'test',
		exclusiveAppId: null,
		providerTargetJson: '{}',
		state: 'ready',
	})
	const write = (fence: { holder: string; nowMs: number }, providerTargetJson: string, createdAt = row.created_at, claim = true) =>
		harness.db.registry.writeDeploymentNamespace({ id: 'ns', createdAt, fence, providerTargetJson, state: 'provisioning', lastError: null, claim })
	return { ...harness, clock, locks, write, advance: (ms: number) => clock.advance(ms, locks.idle) }
}

test('a namespace write lands only for the live holder of its lease and the same row', async () => {
	const { db, clock, locks, write, sqlite } = await fixture()
	const lease = await acquireLease(locks, namespaceLeaseKey('ns'), clock)
	if (lease === null) throw new Error('lease missing')
	const fence = lease.fence()
	expect(await write({ ...fence, holder: 'foreign' }, '{"foreign":true}')).toBe(false)
	expect(await write({ ...fence, nowMs: fence.nowMs + LEASE_TTL_MS }, '{"expired":true}')).toBe(false)
	expect(await write(fence, '{"recreated":true}', 0)).toBe(false)
	expect(await write(fence, '{"held":true}')).toBe(true)
	expect((await db.registry.getDeploymentNamespace('ns'))?.provider_target_json).toBe('{"held":true}')
	await lease.release()
	sqlite.close()
})

test('only a claiming write moves a requeued namespace out of pending', async () => {
	const { db, clock, locks, write, sqlite } = await fixture()
	expect(await db.registry.requeueDeploymentNamespace('ns')).not.toBeNull()
	const lease = await acquireLease(locks, namespaceLeaseKey('ns'), clock)
	if (lease === null) throw new Error('lease missing')
	expect(await write(lease.fence(), '{"rebuilt":true}', undefined, false)).toBe(true)
	expect(await db.registry.getDeploymentNamespace('ns')).toMatchObject({ state: 'pending', provider_target_json: '{"rebuilt":true}' })
	expect(await write(lease.fence(), '{"claimed":true}')).toBe(true)
	expect((await db.registry.getDeploymentNamespace('ns'))?.state).toBe('provisioning')
	await lease.release()
	sqlite.close()
})

for (const renewal of ['refused', 'error', 'hanging'] as const) {
	test(`a namespace holder whose renewal is ${renewal} cannot overwrite its replacement`, async () => {
		const { db, clock, locks, write, advance, sqlite } = await fixture()
		const lease = await acquireLease(locks, namespaceLeaseKey('ns'), clock)
		if (lease === null) throw new Error('lease missing')
		const stale = lease.fence()
		expect(await write(stale, '{"attempt":"old"}')).toBe(true)
		locks.renewal = renewal
		await advance(LEASE_TTL_MS + LEASE_RENEW_MS)
		expect(lease.signal.reason).toBeInstanceOf(ProviderInvocationAbort)
		locks.renewal = 'live'
		const replacement = await acquireLease(locks, namespaceLeaseKey('ns'), clock)
		if (replacement === null) throw new Error('replacement missing')
		expect(await write(replacement.fence(), '{"attempt":"new"}')).toBe(true)
		expect(await write({ ...stale, nowMs: clock.now() }, '{"attempt":"stale"}')).toBe(false)
		await lease.release()
		expect((await db.registry.getDeploymentNamespace('ns'))?.provider_target_json).toBe('{"attempt":"new"}')
		expect(await acquireLease(locks, namespaceLeaseKey('ns'), clock)).toBeNull()
		await replacement.release()
		sqlite.close()
	})
}
