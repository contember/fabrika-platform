import { SqlDeployLocks } from '@fabrika/platform'
import { ProviderInvocationAbort } from '@fabrika/provider-contract'
import { expect, test } from 'bun:test'
import { NamespaceOwnership } from '../namespace-ownership'
import type { OwnershipTiming } from '../run-ownership'
import { createHarness } from './helpers/harness'

class Clock implements OwnershipTiming {
	value = 1000
	ttlMs = 90
	pollMs = 10
	now = () => this.value
	private sleepers = new Set<{ at: number; wake(): void }>()
	wait = (ms: number, signal: AbortSignal): Promise<void> =>
		new Promise((resolve, reject) => {
			signal.throwIfAborted()
			const abort = () => {
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
	async advance(ms: number): Promise<void> {
		this.value += ms
		for (const entry of this.sleepers) {
			if (entry.at <= this.value) {
				this.sleepers.delete(entry)
				entry.wake()
			}
		}
		for (let i = 0; i < 40; i++) await Promise.resolve()
	}
}

async function fixture() {
	const harness = createHarness()
	const clock = new Clock()
	const store = new SqlDeployLocks(harness.d1, { now: clock.now })
	const lock = {
		acquire: (key: string, holder: string) => store.acquire(key, holder, clock.ttlMs),
		renew: (key: string, holder: string) => store.renew(key, holder, clock.ttlMs),
		release: (key: string, holder: string) => store.release(key, holder),
	}
	await harness.db.registry.createDeploymentNamespace({
		id: 'ns',
		env: 'prod',
		provider: 'test',
		exclusiveAppId: null,
		providerTargetJson: '{}',
		state: 'ready',
	})
	return { ...harness, clock, lock }
}

test('renewal retains namespace exclusion across repeated lease periods', async () => {
	const { db, clock, lock, sqlite } = await fixture()
	const owner = await NamespaceOwnership.acquire(db.registry, lock, 'ns', clock)
	if (owner === null) throw new Error('missing owner')
	try {
		for (let i = 0; i < 15; i++) {
			await clock.advance(30)
			expect(await NamespaceOwnership.acquire(db.registry, lock, 'ns', clock)).toBeNull()
			await owner.checkpoint(JSON.stringify({ phase: i }), 'provisioning')
		}
		expect(owner.signal.aborted).toBe(false)
	} finally {
		await owner.close()
		sqlite.close()
	}
})

for (const failure of ['false', 'throw', 'hang']) {
	test(`namespace ${failure} renewal aborts and cannot overwrite the replacement`, async () => {
		const { db, clock, lock, sqlite } = await fixture()
		const late = Promise.withResolvers<boolean>()
		const owner = await NamespaceOwnership.acquire(
			db.registry,
			{
				...lock,
				renew: () => failure === 'false' ? Promise.resolve(false) : failure === 'throw' ? Promise.reject(new Error('offline')) : late.promise,
			},
			'ns',
			clock,
		)
		if (owner === null) throw new Error('missing owner')
		await owner.checkpoint('{"attempt":"old"}', 'provisioning')
		await clock.advance(30)
		await clock.advance(61)
		expect(owner.signal.reason).toBeInstanceOf(ProviderInvocationAbort)
		const replacement = await NamespaceOwnership.acquire(db.registry, lock, 'ns', clock)
		if (replacement === null) throw new Error('missing replacement')
		await replacement.checkpoint('{"attempt":"new"}', 'provisioning')
		await expect(owner.checkpoint('{"attempt":"stale"}', 'ready')).rejects.toThrow()
		await owner.close()
		late.resolve(true)
		expect(await lock.acquire('namespace:ns', 'intruder')).toBe(false)
		expect((await db.registry.getDeploymentNamespace('ns'))?.provider_target_json).toBe('{"attempt":"new"}')
		await replacement.close()
		sqlite.close()
	})
}

test('namespace CAS refuses stale state, target, coordinates and expired holders', async () => {
	const { db, clock, lock, sqlite } = await fixture()
	const expected = await db.registry.getDeploymentNamespace('ns')
	if (expected === null) throw new Error('missing namespace')
	await lock.acquire('namespace:ns', 'owner')
	const input = {
		expected,
		holder: 'owner',
		nowMs: clock.now(),
		providerTargetJson: '{"next":true}',
		state: 'provisioning',
		lastError: null,
	} satisfies Parameters<typeof db.registry.checkpointDeploymentNamespace>[0]
	for (
		const wrong of [
			{ ...input, holder: 'foreign' },
			{ ...input, nowMs: 1090 },
			{ ...input, expected: { ...expected, env: 'stage' } },
			{ ...input, expected: { ...expected, provider_target_json: '{"stale":true}' } },
			{ ...input, expected: { ...expected, state: 'failed' } } satisfies typeof input,
		]
	) expect(await db.registry.checkpointDeploymentNamespace(wrong)).toBeNull()
	expect(await db.registry.checkpointDeploymentNamespace(input)).not.toBeNull()
	expect(await db.registry.checkpointDeploymentNamespace(input)).toBeNull()
	sqlite.close()
})
