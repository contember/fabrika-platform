import { ProviderInvocationAbort } from '@fabrika/provider-contract'
import { expect, test } from 'bun:test'
import { ZeropsApiError } from '../api'
import { cleanupManagedReservation } from '../managed-environment/cleanup'

for (const observation of ['present', 'unknown', 'wrong-status', 'wrong-code', 'absent']) {
	test(`pre-submission cleanup settles only exact absence: ${observation}`, async () => {
		const calls: string[] = []
		const settled = await cleanupManagedReservation({
			runId: 'run',
			appVersionId: 'candidate',
			signal: new AbortController().signal,
			sleep: async () => {},
			source: {
				cancel: async () => {
					throw new Error('source unavailable')
				},
			},
			api: {
				deleteAppVersion: async ({ appVersionId }) => {
					calls.push(`delete:${appVersionId}`)
				},
				getAppVersion: async ({ appVersionId }) => {
					calls.push(`observe:${appVersionId}`)
					if (observation === 'present') return { id: appVersionId, status: 'UPLOADING' }
					if (observation === 'unknown') throw new Error('read unavailable')
					throw new ZeropsApiError('redacted', observation === 'wrong-status' ? 404 : 400, observation === 'wrong-code' ? 'other' : 'appVersionNotFound')
				},
			},
		})
		expect(settled).toBe(observation === 'absent')
		expect(calls).toEqual(['delete:candidate', 'observe:candidate'])
	})
}

test('lease loss during best-effort cancellation forbids deletion', async () => {
	const controller = new AbortController()
	const reason = new ProviderInvocationAbort('lease_lost')
	let deleted = false
	await expect(cleanupManagedReservation({
		runId: 'run',
		appVersionId: 'candidate',
		signal: controller.signal,
		sleep: async () => {},
		source: {
			cancel: async () => {
				controller.abort(reason)
			},
		},
		api: {
			deleteAppVersion: async () => {
				deleted = true
			},
			getAppVersion: async () => {
				throw new Error('must not observe')
			},
		},
	})).rejects.toBe(reason)
	expect(deleted).toBe(false)
})

test('unknown delete remains unresolved even if a later read might report absence', async () => {
	let observed = false
	expect(
		await cleanupManagedReservation({
			runId: 'run',
			appVersionId: 'candidate',
			signal: new AbortController().signal,
			sleep: async () => {},
			source: { cancel: async () => {} },
			api: {
				deleteAppVersion: async () => {
					throw new Error('lost delete response')
				},
				getAppVersion: async () => {
					observed = true
					throw new ZeropsApiError('absent', 400, 'appVersionNotFound')
				},
			},
		}),
	).toBe(false)
	expect(observed).toBe(false)
})
