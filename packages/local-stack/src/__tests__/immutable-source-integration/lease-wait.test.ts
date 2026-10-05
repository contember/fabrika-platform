import { expect, test } from 'bun:test'
import { DEPLOY_LEASE_TTL_MS } from '../../../../control/src/run-ownership'
import { waitForDeployLeaseExpiry } from '../../smoke'
import { deployLeaseSchema } from '../../smoke-schemas'

test('waits for persisted expiry and reads again before allowing restart', async () => {
	let now = 1000
	const expiresAt = now + DEPLOY_LEASE_TTL_MS
	const observations: number[] = []
	await waitForDeployLeaseExpiry(async () => {
		observations.push(now)
		return { expiresAt }
	}, {
		now: () => now,
		sleep: async ms => {
			now += ms
		},
	})
	expect(observations.length).toBeGreaterThan(1)
	expect(observations.at(-1)).toBeGreaterThanOrEqual(expiresAt)
	expect(now).toBeLessThanOrEqual(expiresAt + 1000)
})

test('absent or already expired leases need no delay', async () => {
	let sleeps = 0
	const timing = {
		now: () => 1000,
		sleep: async () => {
			sleeps++
		},
	}
	await waitForDeployLeaseExpiry(async () => null, timing)
	await waitForDeployLeaseExpiry(async () => ({ expiresAt: 1000 }), timing)
	expect(sleeps).toBe(0)
})

test('a continually renewed lease fails within the bounded production TTL plus margin', async () => {
	let now = 0
	await expect(waitForDeployLeaseExpiry(async () => ({ expiresAt: now + DEPLOY_LEASE_TTL_MS }), {
		now: () => now,
		sleep: async ms => {
			now += ms
		},
	})).rejects.toThrow('Timed out')
	expect(now).toBe(DEPLOY_LEASE_TTL_MS + 60_000)
})

test('lease query rejects malformed expiry instead of treating it as unlocked', () => {
	for (const expiresAt of ['1800000', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		expect(deployLeaseSchema.safeParse({ expiresAt }).success).toBe(false)
	}
})
