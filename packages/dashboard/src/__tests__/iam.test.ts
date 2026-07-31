import type { RpcFetch } from '@fabrika/app'
import { describe, expect, test } from 'bun:test'
import { iamSnapshot } from '../lib/iam'

function iamFetch(methods: string[]): RpcFetch {
	return async (_input, init) => {
		if (typeof init?.body !== 'string') throw new Error('expected JSON RPC body')
		const body: unknown = JSON.parse(init.body)
		if (body === null || typeof body !== 'object' || !('method' in body) || typeof body.method !== 'string') {
			throw new Error('expected RPC method')
		}
		methods.push(body.method)
		switch (body.method) {
			case 'principals.list':
				return Response.json({ result: { items: [{ id: 'user-1' }] } })
			case 'apiKeys.list':
				return Response.json({ result: { items: [{ id: 'key-1' }] } })
			case 'shareLinks.list':
				return Response.json({ result: { items: [{ id: 'share-1' }] } })
			case 'audit.list':
				return Response.json({ result: { items: [{ id: 'audit-1' }], nextCursor: null } })
			default:
				return Response.json({ error: { type: 'not_found', message: 'unknown method' } }, { status: 404 })
		}
	}
}

describe('IAM overview snapshot', () => {
	test('uses the four typed read procedures', async () => {
		const methods: string[] = []
		const snapshot = await iamSnapshot(iamFetch(methods))

		expect(methods).toEqual(['principals.list', 'apiKeys.list', 'shareLinks.list', 'audit.list'])
		expect(snapshot?.principals).toEqual([{ id: 'user-1' }])
		expect(snapshot?.apiKeys).toEqual([{ id: 'key-1' }])
		expect(snapshot?.shareLinks).toEqual([{ id: 'share-1' }])
		expect(snapshot?.audit).toEqual([{ id: 'audit-1' }])
	})

	test('stays quiet on auth errors instead of starting a login bounce', async () => {
		const snapshot = await iamSnapshot(async () =>
			Response.json(
				{ error: { type: 'auth', message: 'IAM admin denied', loginUrl: 'https://iam.example/login' } },
				{ status: 401 },
			)
		)

		expect(snapshot).toBeNull()
	})

	test('stays quiet when IAM is unreachable', async () => {
		const snapshot = await iamSnapshot(async () => {
			throw new Error('offline')
		})

		expect(snapshot).toBeNull()
	})
})
