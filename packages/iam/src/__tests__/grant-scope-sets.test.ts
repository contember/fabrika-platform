import { permits } from '@fabrika/auth-core'
import { MAX_GRANT_SCOPE_VALUES } from '@fabrika/iam-contract'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type AdminContext } from '../admin/context'
import { decideGrantRequestUseCase, listGrantRequestsUseCase } from '../admin/grant-requests'
import { adminUseCases } from '../admin/handlers'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { resolvePermissionsAt } from '../resolve'
import { applied } from './helpers/grants'
import { createHarness, makeServicesFor } from './helpers/harness'
import { APP, membershipFixture, ONBOARDING_SCHEMA } from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

async function fixture(repositories: IamRepositories) {
	const f = await membershipFixture(repositories)
	await f.putSchema(ONBOARDING_SCHEMA)
	const admin = await repositories.principals.createUser(crypto.randomUUID(), `${crypto.randomUUID()}@example.test`)
	const user = await repositories.principals.createUser(crypto.randomUUID(), `${crypto.randomUUID()}@example.test`)
	const url = new URL('https://iam.example.test/admin/rpc')
	const services = makeServicesFor(repositories, { authentication: { oidc: true, password: true } })
	const context: AdminContext = {
		services,
		admin: { id: admin.id, label: admin.label, type: 'user', permissions: [{ action: '*', scope: null, source: 'grant' }] },
		administration: { kind: 'installation' },
		app: 'propustka',
		requestId: crypto.randomUUID(),
		url,
		request: new Request(url),
		ctx: f.ctx,
	}
	/** Whether the user holds `notes.write` in the workspace `value`, resolved as a mint resolves it. */
	const writes = async (value: string) => {
		const principal = await repositories.principals.getPrincipalById(user.id)
		if (principal === null) throw new Error('principal')
		return permits(await resolvePermissionsAt(services, principal, APP), 'notes.write', { type: 'workspace', value })
	}
	const records = async (action: string) => (await adminUseCases.listAudit(context, { subjectPrincipalId: user.id, action })).items
	const approver = await repositories.principals.createUser(crypto.randomUUID(), `${crypto.randomUUID()}@example.test`)
	const approving: AdminContext = { ...context, admin: { ...context.admin, id: approver.id, label: approver.label }, requestId: crypto.randomUUID() }
	/** Make the application's grants wait (ADR-0083), or apply at once, as Control does; the Postgres schema is shared. */
	const gate = async (required = true) => {
		gateRevision += 1
		await repositories.grantRequests.setGrantsWait(APP, required, gateRevision, Math.floor(Date.now() / 1000), {
			requestId: crypto.randomUUID(),
			principalId: admin.id,
			principalLabel: admin.label,
			app: APP,
			action: 'iam.grant_approval.set',
			resourceType: 'app',
			resourceId: APP,
			metadata: {},
		})
	}
	/** The request a gated change answered with, approved by a second administrator in a session. */
	const approve = async (change: unknown) => {
		const id = pendingId(change)
		return await decideGrantRequestUseCase(approving, true, { id, decision: 'approve' })
	}
	await gate(false)
	return { repositories, context, user, writes, records, gate, approve }
}

let gateRevision = 0

function pendingId(change: unknown): string {
	if (typeof change !== 'object' || change === null || !('pending' in change)) throw new Error('the change applied at once')
	const { pending } = change
	if (typeof pending !== 'object' || pending === null || !('id' in pending) || typeof pending.id !== 'string') throw new Error('no request id')
	return pending.id
}

function suite(label: string, backend: () => IamRepositories) {
	describe(`a grant of several scope values (${label})`, () => {
		test('allows each listed value, denies every other, and is one grant with one record', async () => {
			const f = await fixture(backend())
			const grant = applied(
				await adminUseCases.createGrant(f.context, {
					principalId: f.user.id,
					app: APP,
					roleKey: 'editor',
					scopeType: 'workspace',
					scopeValues: ['beta', 'alpha'],
				}),
			)
			expect(grant).toMatchObject({ scopeType: 'workspace', scopeValue: 'alpha', scopeValues: ['alpha', 'beta'] })
			expect(await f.writes('alpha')).toBe(true)
			expect(await f.writes('beta')).toBe(true)
			expect(await f.writes('gamma')).toBe(false)
			expect(await f.records('iam.grant.create')).toHaveLength(1)
			const detail = await adminUseCases.getPrincipal(f.context, { principalId: f.user.id })
			expect(detail.grants.map((each) => [each.id, each.scopeValues])).toEqual([[grant.id, ['alpha', 'beta']]])
		})

		test('leaves a grant of one value as it was: one row, no set, the same id', async () => {
			const f = await fixture(backend())
			const grant = applied(
				await adminUseCases.createGrant(f.context, {
					principalId: f.user.id,
					app: APP,
					roleKey: 'editor',
					scopeType: 'workspace',
					scopeValue: 'alpha',
				}),
			)
			expect(grant).toMatchObject({ scopeValue: 'alpha', scopeValues: ['alpha'] })
			const row = await f.repositories.grants.getGrantById(grant.id)
			expect(row).toMatchObject({ scope_value: 'alpha', scope_set: null })
			expect(await f.writes('alpha')).toBe(true)
			expect(await f.writes('beta')).toBe(false)
		})

		test('edits the set under the same id, and a set shrunk to one value becomes a plain grant', async () => {
			const f = await fixture(backend())
			const grant = applied(
				await adminUseCases.createGrant(f.context, {
					principalId: f.user.id,
					app: APP,
					roleKey: 'editor',
					scopeType: 'workspace',
					scopeValue: 'alpha',
				}),
			)
			const widened = applied(
				await adminUseCases.updateGrant(f.context, {
					id: grant.id,
					roleKey: 'editor',
					scopeType: 'workspace',
					scopeValues: ['beta', 'gamma'],
				}),
			)
			expect(widened).toMatchObject({ id: grant.id, scopeValues: ['beta', 'gamma'] })
			expect(await f.writes('alpha')).toBe(false)
			expect(await f.writes('gamma')).toBe(true)
			const [record] = await f.records('iam.grant.update')
			expect(record?.diff).toMatchObject({ before: { scopeValue: 'alpha' }, after: { scopeValue: 'beta', scopeValues: ['beta', 'gamma'] } })
			const narrowed = applied(
				await adminUseCases.updateGrant(f.context, { id: grant.id, roleKey: 'editor', scopeType: 'workspace', scopeValues: ['gamma'] }),
			)
			expect(narrowed).toMatchObject({ id: grant.id, scopeValues: ['gamma'] })
			expect(await f.repositories.grants.getGrantById(grant.id)).toMatchObject({ scope_value: 'gamma', scope_set: null })
			expect(await f.records('iam.grant.update')).toHaveLength(2)
		})

		test('revokes every value at once, with one record', async () => {
			const f = await fixture(backend())
			const grant = applied(
				await adminUseCases.createGrant(f.context, {
					principalId: f.user.id,
					app: APP,
					roleKey: 'editor',
					scopeType: 'workspace',
					scopeValues: ['alpha', 'beta', 'gamma'],
				}),
			)
			await adminUseCases.deleteGrant(f.context, { id: grant.id })
			expect(await f.writes('alpha')).toBe(false)
			expect(await f.writes('gamma')).toBe(false)
			expect(await f.repositories.grants.listGrants(f.user.id)).toEqual([])
			expect(await f.records('iam.grant.revoke')).toHaveLength(1)
		})

		test('refuses a value the principal already holds the role in, naming that grant and writing nothing', async () => {
			const f = await fixture(backend())
			const held = applied(
				await adminUseCases.createGrant(f.context, {
					principalId: f.user.id,
					app: APP,
					roleKey: 'editor',
					scopeType: 'workspace',
					scopeValue: 'beta',
				}),
			)
			const refused = adminUseCases.createGrant(f.context, {
				principalId: f.user.id,
				app: APP,
				roleKey: 'editor',
				scopeType: 'workspace',
				scopeValues: ['alpha', 'beta'],
			})
			await expect(refused).rejects.toMatchObject({ httpStatus: 409 })
			await expect(refused).rejects.toThrow(held.id)
			expect((await f.repositories.grants.listGrants(f.user.id)).map((row) => row.scope_value)).toEqual(['beta'])
			const other = applied(
				await adminUseCases.createGrant(f.context, {
					principalId: f.user.id,
					app: APP,
					roleKey: 'editor',
					scopeType: 'workspace',
					scopeValues: ['alpha', 'gamma'],
				}),
			)
			await expect(adminUseCases.updateGrant(f.context, { id: other.id, roleKey: 'editor', scopeType: 'workspace', scopeValues: ['beta', 'gamma'] }))
				.rejects.toMatchObject({ httpStatus: 409 })
			expect((await f.repositories.grants.getGrantSet(other.id))?.rows.map((row) => row.scope_value)).toEqual(['alpha', 'gamma'])
		})

		test('refuses an empty, oversized or repeating set, and a value beside a set', async () => {
			const f = await fixture(backend())
			const create = (scope: { scopeValue?: string; scopeValues?: string[] }) =>
				adminUseCases.createGrant(f.context, { principalId: f.user.id, app: APP, roleKey: 'editor', scopeType: 'workspace', ...scope })
			await expect(create({ scopeValues: [] })).rejects.toMatchObject({ httpStatus: 400 })
			await expect(create({ scopeValues: Array.from({ length: MAX_GRANT_SCOPE_VALUES + 1 }, (_, index) => `v${index}`) })).rejects
				.toMatchObject({ httpStatus: 400 })
			await expect(create({ scopeValues: ['alpha', 'alpha'] })).rejects.toMatchObject({ httpStatus: 400 })
			await expect(create({ scopeValues: ['alpha', ''] })).rejects.toMatchObject({ httpStatus: 400 })
			await expect(create({ scopeValue: 'alpha', scopeValues: ['beta'] })).rejects.toMatchObject({ httpStatus: 400 })
			expect(await f.repositories.grants.listGrants(f.user.id)).toEqual([])
		})

		test('provisions an API key whose one grant covers several values', async () => {
			const f = await fixture(backend())
			const { principalId } = await adminUseCases.provisionApiKey(f.context, {
				label: 'reports',
				type: 'service',
				app: APP,
				roleKey: 'editor',
				scopeType: 'workspace',
				scopeValues: ['beta', 'alpha'],
			})
			const key = await adminUseCases.getApiKey(f.context, { principalId })
			expect(key.grants.map((each) => each.scopeValues)).toEqual([['alpha', 'beta']])
		})

		test('a gated grant of several values is one request that grants none of them until it is approved', async () => {
			const f = await fixture(backend())
			await f.gate()
			const requested = await adminUseCases.createGrant(f.context, {
				principalId: f.user.id,
				app: APP,
				roleKey: 'editor',
				scopeType: 'workspace',
				scopeValues: ['beta', 'alpha'],
			})
			if (!('pending' in requested)) throw new Error('the grant applied at once')
			expect(requested.pending).toMatchObject({ status: 'pending', scopeValue: 'alpha', scopeValues: ['alpha', 'beta'] })
			expect(await f.repositories.grants.listGrants(f.user.id)).toEqual([])
			expect(await f.writes('alpha')).toBe(false)
			const listed = await listGrantRequestsUseCase(f.context, {})
			expect(listed.items.map((item) => item.scopeValues)).toEqual([['alpha', 'beta']])
			expect(await f.approve(requested)).toMatchObject({ status: 'approved', scopeValues: ['alpha', 'beta'] })
			expect(await f.writes('alpha')).toBe(true)
			expect(await f.writes('beta')).toBe(true)
			expect(await f.writes('gamma')).toBe(false)
			const detail = await adminUseCases.getPrincipal(f.context, { principalId: f.user.id })
			expect(detail.grants.map((each) => each.scopeValues)).toEqual([['alpha', 'beta']])
			const [record] = await f.records('iam.grant.create')
			expect(record?.metadata).toMatchObject({ scopeValue: 'alpha', scopeValues: ['alpha', 'beta'], grantRequestId: requested.pending.id })
		})

		test('a gated edit and revocation of a set wait, then act on every value under the same id', async () => {
			const f = await fixture(backend())
			const grant = applied(
				await adminUseCases.createGrant(f.context, {
					principalId: f.user.id,
					app: APP,
					roleKey: 'editor',
					scopeType: 'workspace',
					scopeValues: ['alpha', 'beta'],
				}),
			)
			await f.gate()
			const edit = await adminUseCases.updateGrant(f.context, {
				id: grant.id,
				roleKey: 'editor',
				scopeType: 'workspace',
				scopeValues: ['beta', 'gamma'],
			})
			expect(await f.writes('alpha')).toBe(true)
			expect(await f.writes('gamma')).toBe(false)
			expect(await f.approve(edit)).toMatchObject({ status: 'approved', grantId: grant.id })
			expect(await f.writes('alpha')).toBe(false)
			expect(await f.writes('gamma')).toBe(true)
			expect((await f.repositories.grants.getGrantSet(grant.id))?.rows.map((row) => row.scope_value)).toEqual(['beta', 'gamma'])

			const revocation = await adminUseCases.deleteGrant(f.context, { id: grant.id })
			expect(revocation.pending?.scopeValues).toEqual(['beta', 'gamma'])
			expect(await f.writes('beta')).toBe(true)
			expect(await f.approve(revocation)).toMatchObject({ status: 'approved' })
			expect(await f.repositories.grants.listGrants(f.user.id)).toEqual([])
			expect(await f.records('iam.grant.revoke')).toHaveLength(1)
		})

		test('an approval refuses a set one of whose values the principal came to hold, and writes none of it', async () => {
			const f = await fixture(backend())
			await f.gate()
			const requested = await adminUseCases.createGrant(f.context, {
				principalId: f.user.id,
				app: APP,
				roleKey: 'editor',
				scopeType: 'workspace',
				scopeValues: ['alpha', 'beta'],
			})
			await f.repositories.grants.createGrant({ principalId: f.user.id, app: APP, roleKey: 'editor', scopeType: 'workspace', scopeValue: 'beta' })
			await expect(f.approve(requested)).rejects.toMatchObject({ httpStatus: 409 })
			// The race past that check: the unique index refuses the set, and the claim rolls back with it.
			const request = await f.repositories.grantRequests.get(pendingId(requested))
			if (request === null) throw new Error('the request is missing')
			const decision = { id: crypto.randomUUID(), by: f.context.admin.id, at: Math.floor(Date.now() / 1000) }
			await expect(f.repositories.grants.applyRequest(request, null, decision, (grantId) => ({
				requestId: 'race',
				principalId: f.context.admin.id,
				principalLabel: 'race',
				app: APP,
				action: 'iam.grant.create',
				resourceType: 'grant',
				resourceId: grantId,
				metadata: {},
			}))).rejects.toThrow()
			expect((await f.repositories.grantRequests.get(request.id))?.status).toBe('pending')
			expect((await f.repositories.grants.listGrants(f.user.id)).map((row) => row.scope_value)).toEqual(['beta'])
		})
	})
}

suite('SQLite', () => createHarness().repositories)

if (!hasPostgres) console.warn(`grant-scope-sets.test.ts ${skipReason}`)
describe.skipIf(!hasPostgres)('on Postgres', () => {
	let backend: PostgresFixture | null = null
	beforeAll(async () => {
		backend = await createPostgres('iam_grant_scope_sets')
	})
	afterAll(async () => {
		await backend?.close()
	})
	suite('Postgres', () => {
		if (backend === null) throw new Error('fixture')
		return createPostgresIamRepositories(backend.db)
	})
})
