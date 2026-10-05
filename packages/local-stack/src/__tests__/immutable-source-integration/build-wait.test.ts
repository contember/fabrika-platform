import { expect, test } from 'bun:test'
import { DURABLE_BUILD_WAIT_MS, poll } from '../../smoke'

test('durable build wait admits sequential staging beyond 30 seconds and returns at the first submitted checkpoint', async () => {
	let now = 0
	let reads = 0
	const submittedAt = 40_000
	const phase = await poll(
		'durable build',
		async () => {
			reads++
			return now < submittedAt ? 'managed_env_staging' : 'build_triggered'
		},
		value => value === 'build_triggered',
		{
			timeoutMs: DURABLE_BUILD_WAIT_MS,
			now: () => now,
			sleep: async ms => {
				now += ms
			},
		},
	)
	expect(phase).toBe('build_triggered')
	expect(now).toBe(submittedAt)
	expect(reads).toBe(201)
})

test('staging never substitutes for build submission and the separate build budget remains bounded', async () => {
	let now = 0
	await expect(poll('durable build', async () => 'managed_env_staging', value => value === 'build_triggered', {
		timeoutMs: DURABLE_BUILD_WAIT_MS,
		now: () => now,
		sleep: async ms => {
			now += ms
		},
	})).rejects.toThrow('timed out waiting for durable build')
	expect(now).toBe(DURABLE_BUILD_WAIT_MS)
})
