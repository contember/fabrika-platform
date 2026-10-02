import { describe, expect, test } from 'bun:test'
import { createZeropsApi } from '../api/client'
import { parseServiceEnvResponse } from '../api/service-env-response'
import { createManagedRecord } from '../managed-environment/staging'

describe('strict raw managed-environment observation', () => {
	const valid = { id: 'record', key: 'KEY', content: '', serviceStackId: 'service', type: 'USER', sensitive: true }

	test('preserves empty values and unknown unrelated types while discarding unused wire fields', () => {
		expect(parseServiceEnvResponse({ items: [{ ...valid, type: 'FUTURE_TYPE', unused: true }] }, 'service')).toEqual([{
			...valid,
			type: 'FUTURE_TYPE',
		}])
		expect(parseServiceEnvResponse({ items: [{ id: 'record', key: 'KEY', content: '' }] }, 'service')).toEqual([{
			id: 'record',
			key: 'KEY',
			content: '',
		}])
		expect(parseServiceEnvResponse({ items: [] }, 'service')).toEqual([])
		expect(parseServiceEnvResponse({ items: [{ ...valid, sensitive: false }] }, 'service')).toEqual([{ ...valid, sensitive: false }])
	})

	test('sensitive is optional but must be a boolean when supplied', () => {
		for (const sensitive of [undefined, null, 0, 1, 'true', 'false', {}, []]) {
			expect(() => parseServiceEnvResponse({ items: [{ ...valid, sensitive }] }, 'service')).toThrow('invalid service environment response')
		}
	})

	test('actual API create/sync/read path preserves sensitive USER records for confirmation', async () => {
		const key = `FABRIKA_MENV_${'a'.repeat(48)}_R`
		const paths: string[] = []
		const api = createZeropsApi({
			token: 'test-token',
			baseUrl: 'https://zerops.test',
			fetchImpl: async (url, init) => {
				paths.push(url)
				if (url.endsWith('/user-data')) {
					expect(init?.method).toBe('POST')
					expect(init?.body).toBe(JSON.stringify({ key, content: 'dummy', sensitive: true }))
					return Response.json({ id: 'sync', actionName: 'stack.updateUserData', serviceStackId: 'service', status: 'PENDING' })
				}
				if (url.endsWith('/process/sync')) return Response.json({ id: 'sync', actionName: 'stack.updateUserData', status: 'FINISHED' })
				if (url.endsWith('/env')) return Response.json({ items: [{ ...valid, key, content: 'dummy' }] })
				throw new Error('unexpected API call')
			},
		})
		await expect(createManagedRecord({ api, serviceId: 'service', key, value: 'dummy', signal: new AbortController().signal, sleep: async () => {} }))
			.resolves.toEqual({ referenceName: key, backingRecordId: 'record' })
		expect(paths).toEqual([
			'https://zerops.test/service-stack/service/user-data',
			'https://zerops.test/process/sync',
			'https://zerops.test/service-stack/service/env',
		])
	})

	test('malformed lists and records are not coerced to absence or empty content', () => {
		for (const payload of [null, [], {}, { items: null }, { items: {} }, { items: [null] }, { items: [[]] }, { items: [{}] }]) {
			expect(() => parseServiceEnvResponse(payload, 'service')).toThrow('invalid service environment response')
		}
		for (const field of ['id', 'key', 'content', 'serviceStackId', 'type']) {
			for (const value of [undefined, null, 1, false, {}, []]) {
				expect(() => parseServiceEnvResponse({ items: [{ ...valid, [field]: value }] }, 'service')).toThrow()
			}
		}
		for (const field of ['id', 'key', 'serviceStackId', 'type']) {
			expect(() => parseServiceEnvResponse({ items: [{ ...valid, [field]: '' }] }, 'service')).toThrow()
		}
	})

	test('rejects supplied foreign service association, duplicate IDs and duplicate keys without payload details', () => {
		for (
			const items of [
				[{ ...valid, serviceStackId: 'foreign' }],
				[valid, { ...valid, id: 'other' }],
				[valid, { ...valid, key: 'OTHER' }],
				[{ ...valid, id: null, content: 'DO-NOT-LOG-THIS' }],
			]
		) {
			try {
				parseServiceEnvResponse({ items }, 'service')
				throw new Error('expected refusal')
			} catch (error) {
				expect(String(error)).toContain('invalid service environment response')
				expect(String(error)).not.toContain('DO-NOT-LOG-THIS')
			}
		}
	})
})
