// `statusOf` of `@fabrika/app/testing`: the status a test asserts, never `undefined`.

import { RpcError } from '@fabrika/app/client'
import { statusOf } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'

describe('statusOf', () => {
	test('a call that resolves is 200', async () => {
		expect(await statusOf(Promise.resolve({ id: 'x' }))).toBe(200)
	})

	test('a refusal of the application is its status', async () => {
		expect(await statusOf(Promise.reject(new RpcError({ type: 'conflict', message: 'stale', httpStatus: 409 })))).toBe(409)
		expect(await statusOf(Promise.reject(new RpcError({ type: 'forbidden', message: 'no', httpStatus: 403 })))).toBe(403)
	})

	test('an RpcError without a status is rethrown', async () => {
		const unanswered = new RpcError({ type: 'network', message: 'no answer' })
		await expect(statusOf(Promise.reject(unanswered))).rejects.toBe(unanswered)
	})

	test('any other failure is rethrown', async () => {
		const bug = new TypeError('a bug in the test')
		await expect(statusOf(Promise.reject(bug))).rejects.toBe(bug)
	})
})
