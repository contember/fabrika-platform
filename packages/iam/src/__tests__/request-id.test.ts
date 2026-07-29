import { describe, expect, test } from 'bun:test'
import { requestId } from '../request-id'

describe('requestId', () => {
	test('prefers the proxy id over cf-ray', () => {
		const request = new Request('https://iam.test', {
			headers: { 'X-Request-Id': 'proxy-1', 'cf-ray': 'ray-1' },
		})
		expect(requestId(request, () => 'generated')).toBe('proxy-1')
	})

	test('uses cf-ray when the proxy id is absent', () => {
		const request = new Request('https://iam.test', { headers: { 'cf-ray': 'ray-1' } })
		expect(requestId(request, () => 'generated')).toBe('ray-1')
	})

	test('generates an id when neither upstream supplies one', () => {
		expect(requestId(new Request('https://iam.test'), () => 'generated')).toBe('generated')
	})
})
