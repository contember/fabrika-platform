import type { RpcFetch } from '@fabrika/app'
import { describe, expect, test } from 'bun:test'
import { findPeople, iamPrincipals, recentAuditChangePage, recentAuditChanges } from '../lib/iam'

function iamFetch(methods: string[], bodies: string[] = []): RpcFetch {
	return async (_input, init) => {
		if (typeof init?.body !== 'string') throw new Error('expected JSON RPC body')
		bodies.push(init.body)
		const body: unknown = JSON.parse(init.body)
		if (body === null || typeof body !== 'object' || !('method' in body) || typeof body.method !== 'string') {
			throw new Error('expected RPC method')
		}
		methods.push(body.method)
		switch (body.method) {
			case 'principals.list':
				return Response.json({ result: { items: [{ id: 'user-1' }] } })
			default:
				return Response.json({ error: { type: 'not_found', message: 'unknown method' } }, { status: 404 })
		}
	}
}

describe('IAM principals for the overview', () => {
	test('reads the people and nothing else, since every admin read is audited', async () => {
		const methods: string[] = []
		const bodies: string[] = []
		const principals = await iamPrincipals(iamFetch(methods, bodies))

		expect(methods).toEqual(['principals.list'])
		expect(bodies[0]).toContain('"type":"user"')
		expect(principals).toEqual([{ id: 'user-1' }])
	})

	test('stays quiet on auth errors instead of starting a login bounce', async () => {
		const principals = await iamPrincipals(async () =>
			Response.json(
				{ error: { type: 'auth', message: 'IAM admin denied', loginUrl: 'https://iam.example/login' } },
				{ status: 401 },
			)
		)

		expect(principals).toBeNull()
	})

	test('stays quiet when IAM is unreachable', async () => {
		const principals = await iamPrincipals(async () => {
			throw new Error('offline')
		})

		expect(principals).toBeNull()
	})
})

describe('IAM people for the command palette', () => {
	test('asks IAM to search the people, so it is not limited to a first page', async () => {
		const methods: string[] = []
		const bodies: string[] = []
		expect(await findPeople('ada', 8, iamFetch(methods, bodies))).toEqual([{ id: 'user-1' }])
		expect(methods).toEqual(['principals.list'])
		expect(bodies[0]).toContain('"q":"ada"')
		expect(bodies[0]).toContain('"type":"user"')
	})

	test('stays quiet when IAM is unreachable', async () => {
		expect(
			await findPeople('ada', 8, async () => {
				throw new Error('offline')
			}),
		).toBeNull()
	})
})

/** One `audit.list` answer; records the input of every call. */
function auditPage(items: Array<{ id: string; action: string }>, nextCursor: string | null, inputs: unknown[]): RpcFetch {
	return async (_input, init) => {
		if (typeof init?.body !== 'string') throw new Error('expected JSON RPC body')
		const body: unknown = JSON.parse(init.body)
		if (body === null || typeof body !== 'object' || !('input' in body)) throw new Error('expected RPC input')
		inputs.push(body.input)
		return Response.json({ result: { items, nextCursor } })
	}
}

describe('recent audit changes', () => {
	test('asks IAM for changes only, in one call', async () => {
		const inputs: unknown[] = []
		const changes = await recentAuditChanges(
			2,
			auditPage([{ id: 'b', action: 'app.create' }, { id: 'd', action: 'iam.grant.create' }, { id: 'e', action: 'namespace.create' }], 'e', inputs),
		)

		expect(changes?.map((event) => event.id)).toEqual(['b', 'd'])
		expect(inputs).toEqual([{ changesOnly: true, limit: 50 }])
	})

	test('still leaves out the reads an IAM older than changesOnly returns', async () => {
		const inputs: unknown[] = []
		const changes = await recentAuditChangePage(
			6,
			auditPage([{ id: 'a', action: 'iam.admin.access' }, { id: 'b', action: 'app.create' }, { id: 'c', action: 'iam.admin.access' }], 'c', inputs),
		)

		expect(changes.items.map((event) => event.id)).toEqual(['b'])
		// Fewer changes than wanted while older rows exist: the feed says it may miss some.
		expect(changes.limited).toBe(true)
		expect(inputs).toHaveLength(1)
	})

	test('stays quiet when IAM refuses', async () => {
		const changes = await recentAuditChanges(6, async () => Response.json({ error: { type: 'auth', message: 'denied' } }, { status: 403 }))

		expect(changes).toBeNull()
	})
})
