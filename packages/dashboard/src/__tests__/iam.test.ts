import type { RpcFetch } from '@fabrika/app'
import { describe, expect, test } from 'bun:test'
import { findPeople, iamPrincipals, recentAuditChanges } from '../lib/iam'

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

/** An audit log served in pages of the `audit.list` shape; records the `before` of every call. */
function auditPages(pages: Array<Array<{ id: string; action: string }>>, cursors: Array<string | null>): RpcFetch {
	return async (_input, init) => {
		if (typeof init?.body !== 'string') throw new Error('expected JSON RPC body')
		const body: unknown = JSON.parse(init.body)
		if (body === null || typeof body !== 'object' || !('input' in body) || body.input === null || typeof body.input !== 'object') {
			throw new Error('expected RPC input')
		}
		const before = 'before' in body.input && typeof body.input.before === 'string' ? body.input.before : null
		cursors.push(before)
		const index = before === null ? 0 : Number(before.slice('page-'.length))
		const items = pages[index] ?? []
		const nextCursor = index + 1 < pages.length ? `page-${index + 1}` : null
		return Response.json({ result: { items, nextCursor } })
	}
}

describe('recent audit changes', () => {
	test('leaves out admin reads and pages back until it has enough changes', async () => {
		const cursors: Array<string | null> = []
		const changes = await recentAuditChanges(
			2,
			auditPages([
				[{ id: 'a', action: 'iam.admin.access' }, { id: 'b', action: 'app.create' }],
				[{ id: 'c', action: 'iam.admin.access' }, { id: 'd', action: 'iam.grant.create' }, { id: 'e', action: 'namespace.create' }],
				[{ id: 'f', action: 'access.approve' }],
			], cursors),
		)

		expect(changes?.map((event) => event.id)).toEqual(['b', 'd'])
		expect(cursors).toEqual([null, 'page-1'])
	})

	test('stops after three pages even when they hold only reads', async () => {
		const cursors: Array<string | null> = []
		const reads = [{ id: 'r', action: 'iam.admin.access' }]
		const changes = await recentAuditChanges(6, auditPages([reads, reads, reads, reads], cursors))

		expect(changes).toEqual([])
		expect(cursors).toEqual([null, 'page-1', 'page-2'])
	})

	test('stays quiet when IAM refuses', async () => {
		const changes = await recentAuditChanges(6, async () => Response.json({ error: { type: 'auth', message: 'denied' } }, { status: 403 }))

		expect(changes).toBeNull()
	})
})
