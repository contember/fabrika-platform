// The deals slice through the typed client: the pipeline a won or lost deal leaves only by reopening, the owner only a
// manager chooses, the source, and the pipeline report. Each allowed call has a refused twin.

import { createClient } from '@fabrika/app/client'
import { statusOf, type TestCaller, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from '../../../fabrika.contract'
import app from '../../app'
import { DEAL_STAGES } from '../../schemas'

const postgres = await testDatabase({ migrations: new URL('../../../db/migrations/', import.meta.url), label: 'deals.test.ts' })

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database, files: new MemoryFileObjects() })
	const inOrg = (role: 'manager' | 'sales' | 'viewer', org: string, label?: string) =>
		kit.testCaller([{ role, scope: kit.scope('org', org) }], label === undefined ? {} : { label })
	const apiOf = (caller: TestCaller) => createClient(contract, 'api', { fetch: kit.browser(caller) })

	const managerCaller = inOrg('manager', 'acme')
	const manager = apiOf(managerCaller)
	const ola = inOrg('sales', 'acme', 'ola@acme.example')
	const salesCaller = inOrg('sales', 'acme', 'sam@acme.example')
	const sales = apiOf(salesCaller)
	const viewer = apiOf(inOrg('viewer', 'acme'))
	const outsiderCaller = inOrg('manager', 'globex', 'mallory@globex.example')
	const outsider = apiOf(outsiderCaller)

	const newDeal = async (title: string, value = 1000) => {
		const { id: companyId } = await manager.companies.create({ orgId: 'acme', name: `${title} Inc` })
		return { companyId, ...(await sales.deals.create({ companyId, title, value })) }
	}

	describe('the pipeline', () => {
		test('sales move an open deal; a viewer and another org cannot; a stale version is a conflict', async () => {
			const { id } = await newDeal('Compression licence')
			expect((await viewer.deals.get({ id })).stage).toBe('lead')
			expect(await statusOf(viewer.deals.move({ id, stage: 'qualified', expectVersion: 1 }))).toBe(403)
			expect(await statusOf(outsider.deals.move({ id, stage: 'qualified', expectVersion: 1 }))).toBe(404)
			expect(await sales.deals.move({ id, stage: 'qualified', expectVersion: 1 })).toEqual({ id, version: 2 })
			expect(await statusOf(sales.deals.move({ id, stage: 'proposal', expectVersion: 1 }))).toBe(409)
			expect(await sales.deals.edit({ id, title: 'Compression licence (3y)', value: 3000, source: null, expectVersion: 2 })).toEqual({ id, version: 3 })
			expect(await viewer.deals.get({ id })).toMatchObject({ title: 'Compression licence (3y)', value: 3000, stage: 'qualified', version: 3 })
		})

		test('a won deal does not move; it reopens to proposal, and an open deal does not reopen', async () => {
			const { id } = await newDeal('Signed')
			expect(await statusOf(sales.deals.reopen({ id, expectVersion: 1 }))).toBe(409)
			await sales.deals.move({ id, stage: 'won', expectVersion: 1 })
			expect(await statusOf(sales.deals.move({ id, stage: 'lead', expectVersion: 2 }))).toBe(409)
			expect(await statusOf(viewer.deals.reopen({ id, expectVersion: 2 }))).toBe(403)
			expect(await statusOf(outsider.deals.reopen({ id, expectVersion: 2 }))).toBe(404)
			expect(await sales.deals.reopen({ id, expectVersion: 2 })).toEqual({ id, version: 3 })
			expect((await viewer.deals.get({ id })).stage).toBe('proposal')
			expect(await statusOf(sales.deals.reopen({ id, expectVersion: 3 }))).toBe(409)
		})

		test('of two reopens of one lost deal at once, one wins and the other is a conflict', async () => {
			const { id } = await newDeal('Lost twice')
			await sales.deals.move({ id, stage: 'lost', expectVersion: 1 })
			const answers = await Promise.all([statusOf(sales.deals.reopen({ id, expectVersion: 2 })), statusOf(sales.deals.reopen({ id, expectVersion: 2 }))])
			expect([...answers].sort()).toEqual([200, 409])
			expect(await viewer.deals.get({ id })).toMatchObject({ stage: 'proposal', version: 3 })
		})

		test('only a manager deletes a deal', async () => {
			const { id } = await newDeal('Gone')
			expect(await statusOf(sales.deals.remove({ id, expectVersion: 1 }))).toBe(403)
			expect(await manager.deals.remove({ id, expectVersion: 1 })).toEqual({ id })
			expect(await statusOf(viewer.deals.get({ id }))).toBe(404)
		})

		test('of two deletes of one deal at once, one wins and the other finds it gone', async () => {
			const { id } = await newDeal('Deleted twice')
			const answers = await Promise.all([
				statusOf(manager.deals.remove({ id, expectVersion: 1 })),
				statusOf(manager.deals.remove({ id, expectVersion: 1 })),
			])
			expect([...answers].sort()).toEqual([200, 404])
		})
	})

	describe('owner and source', () => {
		test('the creator owns a new deal; a manager hands it to another member of the org, sales cannot', async () => {
			const { id } = await newDeal('Handover')
			expect(await viewer.deals.get({ id })).toMatchObject({ owner: salesCaller.id, ownerLabel: 'sam@acme.example' })
			const newOwner = ola.id
			expect(await statusOf(sales.deals.assign({ id, newOwner, expectVersion: 1 }))).toBe(403)
			expect(await statusOf(outsider.deals.assign({ id, newOwner, expectVersion: 1 }))).toBe(404)
			expect(await manager.deals.assign({ id, newOwner, expectVersion: 1 })).toEqual({ id, version: 2 })
			expect(await viewer.deals.get({ id })).toMatchObject({ owner: ola.id, ownerLabel: 'ola@acme.example' })
		})

		test('the new owner must be an enabled member of the org, and the stored label is the directory’s', async () => {
			const { id } = await newDeal('Picky')
			const disabled = kit.testCaller([{ role: 'sales', scope: kit.scope('org', 'acme') }], { disabled: true })
			expect(await statusOf(manager.deals.assign({ id, newOwner: outsiderCaller.id, expectVersion: 1 }))).toBe(400)
			expect(await statusOf(manager.deals.assign({ id, newOwner: 'user:nobody', expectVersion: 1 }))).toBe(400)
			expect(await statusOf(manager.deals.assign({ id, newOwner: disabled.id, expectVersion: 1 }))).toBe(400)
			const forged = await kit.browser(managerCaller)('/api/deals.assign', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, newOwner: ola.id, ownerLabel: 'boss@acme.example', expectVersion: 1 }),
			})
			expect(forged.status).toBe(400)
			expect(await viewer.deals.get({ id })).toMatchObject({ owner: salesCaller.id, ownerLabel: 'sam@acme.example', version: 1 })
		})

		test('a deal records its source on create and on edit', async () => {
			const { id: companyId } = await manager.companies.create({ orgId: 'acme', name: 'Sourced' })
			const { id } = await sales.deals.create({ companyId, title: 'Referred', value: 10, source: 'referral' })
			expect((await viewer.deals.get({ id })).source).toBe('referral')
			await sales.deals.edit({ id, title: 'Referred', value: 10, source: 'event', expectVersion: 1 })
			expect((await viewer.deals.get({ id })).source).toBe('event')
			expect((await viewer.deals.list({})).items.find((deal) => deal.id === id)?.source).toBe('event')
		})
	})

	describe('the pipeline report', () => {
		test('a stage total beyond a 32-bit integer is answered exactly', async () => {
			const big = apiOf(inOrg('manager', 'initech'))
			const { id: companyId } = await big.companies.create({ orgId: 'initech', name: 'Big Money' })
			for (const title of ['Huge', 'Huger']) {
				const { id } = await big.deals.create({ companyId, title, value: 1_500_000_000 })
				await big.deals.move({ id, stage: 'qualified', expectVersion: 1 })
			}
			const qualified = (await big.deals.pipeline()).stages.find((stage) => stage.stage === 'qualified')
			expect(qualified).toEqual({ stage: 'qualified', count: 2, value: 3_000_000_000 })
		})

		test('counts and sums the deals of each stage in pipeline order, empty stages included, of the caller’s orgs only', async () => {
			const before = await viewer.deals.pipeline()
			await newDeal('Big', 5000)
			await newDeal('Small', 250)
			await outsider.companies.create({ orgId: 'globex', name: 'Elsewhere' })
			const after = await viewer.deals.pipeline()
			expect(after.stages.map((stage) => stage.stage)).toEqual([...DEAL_STAGES])
			const lead = (report: typeof after) => report.stages.find((stage) => stage.stage === 'lead')
			expect(lead(after)?.count).toBe((lead(before)?.count ?? 0) + 2)
			expect(lead(after)?.value).toBe((lead(before)?.value ?? 0) + 5250)
			expect((await outsider.deals.pipeline()).stages).toEqual(DEAL_STAGES.map((stage) => ({ stage, count: 0, value: 0 })))
		})
	})
}
