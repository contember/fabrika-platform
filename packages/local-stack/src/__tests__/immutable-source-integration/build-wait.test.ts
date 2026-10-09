import { expect, test } from 'bun:test'
import { DURABLE_BUILD_WAIT_MS, poll } from '../../notes-deploy'

test('durable build wait admits a slow reservation and upload beyond 30 seconds and returns at the first triggered checkpoint', async () => {
	let now = 0
	let reads = 0
	const submittedAt = 40_000
	const checkpoint = await poll(
		'durable build',
		async () => {
			reads++
			return { appVersionId: 'version-1', triggered: now >= submittedAt }
		},
		value => value.triggered,
		{
			timeoutMs: DURABLE_BUILD_WAIT_MS,
			now: () => now,
			sleep: async ms => {
				now += ms
			},
		},
	)
	expect(checkpoint).toEqual({ appVersionId: 'version-1', triggered: true })
	expect(now).toBe(submittedAt)
	expect(reads).toBe(201)
})

test('a reserved, untriggered version never substitutes for build submission and the build budget remains bounded', async () => {
	let now = 0
	await expect(poll('durable build', async () => ({ appVersionId: 'version-1', triggered: false }), value => value.triggered, {
		timeoutMs: DURABLE_BUILD_WAIT_MS,
		now: () => now,
		sleep: async ms => {
			now += ms
		},
	})).rejects.toThrow('timed out waiting for durable build')
	expect(now).toBe(DURABLE_BUILD_WAIT_MS)
})
