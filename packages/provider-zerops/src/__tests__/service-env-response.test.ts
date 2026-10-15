import { describe, expect, test } from 'bun:test'
import { parseServiceEnvResponse, readableContent } from '../api/service-env-response'

describe('strict raw service-env observation', () => {
	const valid = { id: 'record', key: 'KEY', content: '', serviceStackId: 'service', type: 'USER', sensitive: false }

	test('preserves empty values and unknown unrelated types while discarding unused wire fields', () => {
		expect(parseServiceEnvResponse({ items: [{ ...valid, type: 'FUTURE_TYPE', unused: true }] }, 'service')).toEqual([{
			...valid,
			type: 'FUTURE_TYPE',
		}])
		expect(parseServiceEnvResponse({ items: [{ id: 'record', key: 'KEY', content: '', sensitive: false }] }, 'service')).toEqual([{
			id: 'record',
			key: 'KEY',
			content: '',
			sensitive: false,
		}])
		expect(parseServiceEnvResponse({ items: [] }, 'service')).toEqual([])
	})

	test('drops the content of a sensitive record, whatever the platform sent', () => {
		for (const content of ['REDACTED', 'the-real-secret', '']) {
			const [record] = parseServiceEnvResponse({ items: [{ ...valid, content, sensitive: true }] }, 'service')
			expect(record).toEqual({ id: 'record', key: 'KEY', serviceStackId: 'service', type: 'USER', sensitive: true })
			expect(record).not.toHaveProperty('content')
			expect(readableContent(record)).toBeUndefined()
		}
	})

	test('sensitive is required and must be a boolean', () => {
		expect(() => parseServiceEnvResponse({ items: [{ id: 'record', key: 'KEY', content: '' }] }, 'service')).toThrow(
			'invalid service environment response',
		)
		for (const sensitive of [undefined, null, 0, 1, 'true', 'false', {}, []]) {
			expect(() => parseServiceEnvResponse({ items: [{ ...valid, sensitive }] }, 'service')).toThrow('invalid service environment response')
		}
	})

	test('readableContent reads a readable record and nothing else', () => {
		expect(readableContent({ id: 'record', key: 'KEY', sensitive: false, content: 'value' })).toBe('value')
		expect(readableContent({ id: 'record', key: 'KEY', sensitive: true })).toBeUndefined()
		expect(readableContent(undefined)).toBeUndefined()
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
