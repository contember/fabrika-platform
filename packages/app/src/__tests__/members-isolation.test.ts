// The isolation kits over `members-fixture/` (org → company → deal): each table's policy probe, and the denied, leaked
// and own cases of its deal endpoints, those that pick a member of the org included. The leak sweep asks only the
// leaked cases, and ends an unanswered case as a hint. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { GENERATED_MEMBER } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { endpointAccessKit, policyIsolationKit } from '@fabrika/app/testing/isolation'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from './members-fixture/fabrika.contract'
import { tables } from './members-fixture/src/db/tables'

const postgres = await testDatabase({ migrations: new URL('./members-fixture/db/migrations/', import.meta.url), label: 'members-isolation.test.ts' })
afterAll(() => postgres?.close())

const UUID = '00000000-0000-4000-8000-000000000000'

describe.skipIf(postgres === null)('the policy probe of a chain: a caller of one org reaches no row of another', () => {
	if (postgres === null) return

	test('orgs and companies: get, list and count reach only the own row', async () => {
		for (const table of ['orgs', 'companies'] as const) {
			const kit = policyIsolationKit(contract, tables, table, postgres)
			expect([table, (await kit.get('own')).status]).toEqual([table, 200])
			expect([table, (await kit.get('other')).status]).toEqual([table, 404])
			expect([table, await kit.list()]).toEqual([table, { status: 200, rows: ['own'] }])
			expect([table, await kit.count()]).toEqual([table, { status: 200, count: '1' }])
		}
	})

	test('deals: get, list, count, insert and update reach only the own company, and an update refuses a Ref for crm.read', async () => {
		const kit = policyIsolationKit(contract, tables, 'deals', postgres)
		expect((await kit.get('own')).status).toBe(200)
		expect((await kit.get('other')).status).toBe(404)
		expect(await kit.list()).toEqual({ status: 200, rows: ['own'] })
		expect(await kit.count()).toEqual({ status: 200, count: '1' })
		expect((await kit.insert('own')).status).toBe(200)
		expect((await kit.insert('other')).status).toBe(403)
		expect((await kit.update('own')).status).toBe(200)
		expect((await kit.update('other')).status).toBe(404)
		expect(await kit.updateWithRead()).toEqual({ status: 200, refused: true })
	})
})

describe.skipIf(postgres === null)('the deal endpoints: a caller of one scope reaches nothing of another, and its own object', () => {
	if (postgres === null) return
	const access = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, postgres)
	const assign = { expectVersion: 1, id: UUID, newOwner: GENERATED_MEMBER }
	const candidate = { id: UUID, principalId: GENERATED_MEMBER }

	test('api.deals.assign: 404 for the deal of another scope, nothing of it in an answer, and a caller with only deals.assign reaches its own', async () => {
		expect(await access.denied('api.deals.assign', assign)).toEqual({ status: 404 })
		expect(await access.leaked('api.deals.assign', assign)).toEqual({ answered: true, leaked: [] })
		expect(await access.own('api.deals.assign', assign)).toEqual({ status: 200 })
	})

	test('api.deals.candidate: 404 for the deal of another scope, nothing of it in an answer, and a caller with only deals.write reaches its own', async () => {
		expect(await access.denied('api.deals.candidate', candidate)).toEqual({ status: 404 })
		expect(await access.leaked('api.deals.candidate', candidate)).toEqual({ answered: true, leaked: [] })
		expect(await access.own('api.deals.candidate', candidate)).toEqual({ status: 200 })
	})

	test('api.deals.check: the company of another scope is 403', async () => {
		expect(await access.denied('api.deals.check', { companyId: 'x', principalId: GENERATED_MEMBER })).toEqual({ status: 403 })
	})

	test('api.deals.owner and api.deals.team: 404 for the deal of another scope, and nothing of it in an answer', async () => {
		for (const endpoint of ['api.deals.owner', 'api.deals.team']) {
			expect([endpoint, await access.denied(endpoint, { id: UUID })]).toEqual([endpoint, { status: 404 }])
			expect([endpoint, await access.leaked(endpoint, { id: UUID })]).toEqual([endpoint, { answered: true, leaked: [] }])
		}
	})
})
