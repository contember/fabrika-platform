// The CRM's endpoints as its people call them, behind the production proxy decision. Each allowed call has a refused
// twin: another org, a role without the action, no credential. Runs with `bun test --isolate`, because the generated
// endpoint access test boots the same application, and its data layer binds once per process. The deals slice has
// its own file (src/deals/__tests__/deals.test.ts).

import { createClient } from '@fabrika/app/client'
import { statusOf, type TestCaller, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { contract } from '../../fabrika.contract'
import app from '../app'

const postgres = await testDatabase({ migrations: new URL('../../db/migrations/', import.meta.url), label: 'crm.test.ts' })

const Uploaded = z.strictObject({ result: z.strictObject({ id: z.string() }) })

if (postgres !== null) {
	afterAll(() => postgres.close())
	const objects = new MemoryFileObjects()
	const kit = testKit(app, { database: postgres.database, files: objects })
	const inOrg = (role: 'manager' | 'sales' | 'viewer', org = 'acme') => kit.testCaller([{ role, scope: { type: 'org', value: org } }])
	const apiOf = (caller: TestCaller) => createClient(contract, 'api', { fetch: kit.browser(caller) })

	const managerCaller = kit.testCaller([{ role: 'manager', scope: { type: 'org', value: 'acme' } }], { label: 'mia@acme.example' })
	const manager = apiOf(managerCaller)
	const SALES_LABEL = 'sam@acme.example'
	const sales = kit.testCaller([{ role: 'sales', scope: { type: 'org', value: 'acme' } }], { label: SALES_LABEL })
	const salesApi = apiOf(sales)
	const viewer = inOrg('viewer')
	const viewerApi = apiOf(viewer)
	const outsider = inOrg('manager', 'globex')
	const outsiderApi = apiOf(outsider)

	const newCompany = async (name: string) => (await manager.companies.create({ orgId: 'acme', name })).id
	const newDeal = async (companyId: string, title: string) => (await salesApi.deals.create({ companyId, title, value: 1000, stage: 'lead' })).id

	describe('orgs', () => {
		test('a caller sees the orgs it holds a role in, and only those', async () => {
			expect((await viewerApi.orgs.mine()).orgs).toEqual(['acme'])
			expect((await outsiderApi.orgs.mine()).orgs).toEqual(['globex'])
		})

		test("the org's members are listed with their labels to its members, and to nobody else", async () => {
			const members = (await viewerApi.orgs.members({ orgId: 'acme' })).items
			expect(members).toContainEqual({ principalId: sales.id, label: SALES_LABEL })
			expect(members).toContainEqual({ principalId: managerCaller.id, label: 'mia@acme.example' })
			expect(members.map((member) => member.principalId)).not.toContain(outsider.id)
			expect(await statusOf(outsiderApi.orgs.members({ orgId: 'acme' }))).toBe(403)
		})
	})

	describe('companies and contacts', () => {
		test('a manager creates a company; sales and viewers of the org read it; another org neither lists nor reads it', async () => {
			const { id } = await manager.companies.create({ orgId: 'acme', name: 'Initech' })
			expect((await salesApi.companies.get({ id })).name).toBe('Initech')
			expect((await viewerApi.companies.list({})).items.map((company) => company.id)).toContain(id)
			expect((await outsiderApi.companies.list({})).items).toEqual([])
			expect(await statusOf(outsiderApi.companies.get({ id }))).toBe(404)
		})

		test('only a manager writes companies: sales and viewers are refused, and so is a manager of another org', async () => {
			expect(await statusOf(salesApi.companies.create({ orgId: 'acme', name: 'No' }))).toBe(403)
			expect(await statusOf(viewerApi.companies.create({ orgId: 'acme', name: 'No' }))).toBe(403)
			expect(await statusOf(outsiderApi.companies.create({ orgId: 'acme', name: 'No' }))).toBe(403)
			const id = await newCompany('Hooli')
			expect(await statusOf(salesApi.companies.edit({ id, name: 'Hooli XYZ', website: null, expectVersion: 1 }))).toBe(403)
			expect(await manager.companies.edit({ id, name: 'Hooli XYZ', website: 'https://hooli.example', expectVersion: 1 })).toEqual({ id, version: 2 })
			expect(await statusOf(manager.companies.edit({ id, name: 'Stale', website: null, expectVersion: 1 }))).toBe(409)
		})

		test('a manager adds and edits a contact of a company; sales read it but cannot change it', async () => {
			const companyId = await newCompany('Umbrella')
			const { id } = await manager.contacts.create({ companyId, name: 'Alice', email: 'alice@umbrella.example' })
			expect(await salesApi.contacts.get({ id })).toEqual({ id, companyId, name: 'Alice', email: 'alice@umbrella.example', phone: null, version: 1 })
			expect(await statusOf(salesApi.contacts.create({ companyId, name: 'Bob' }))).toBe(403)
			expect(await statusOf(salesApi.contacts.edit({ id, name: 'Alicia', email: null, phone: null, expectVersion: 1 }))).toBe(403)
			expect(await manager.contacts.edit({ id, name: 'Alicia', email: null, phone: '+1 555', expectVersion: 1 })).toEqual({ id, version: 2 })
			expect((await viewerApi.contacts.list({})).items.map((contact) => contact.id)).toContain(id)
			expect(await statusOf(outsiderApi.contacts.get({ id }))).toBe(404)
			expect(await statusOf(outsiderApi.contacts.create({ companyId, name: 'Mallory' }))).toBe(403)
		})

		test('only a manager deletes: a company goes with its contacts and deals', async () => {
			const companyId = await newCompany('Soon gone')
			const { id: contactId } = await manager.contacts.create({ companyId, name: 'Temp' })
			const dealId = await newDeal(companyId, 'Temp deal')
			expect(await statusOf(salesApi.companies.remove({ id: companyId, expectVersion: 1 }))).toBe(403)
			expect(await manager.companies.remove({ id: companyId, expectVersion: 1 })).toEqual({ id: companyId })
			expect(await statusOf(viewerApi.contacts.get({ id: contactId }))).toBe(404)
			expect(await statusOf(viewerApi.deals.get({ id: dealId }))).toBe(404)
		})
	})

	describe('tasks', () => {
		test('sales add a task to a deal, assigned to themselves by default; a viewer cannot', async () => {
			const dealId = await newDeal(await newCompany('Tasky'), 'Follow up')
			const { id } = await salesApi.tasks.create({ dealId, title: 'Call back', dueOn: '2026-11-03' })
			expect((await viewerApi.tasks.list({})).items.find((item) => item.id === id)).toEqual({
				id,
				dealId,
				title: 'Call back',
				dueOn: '2026-11-03',
				assignee: sales.id,
				assigneeLabel: SALES_LABEL,
				done: false,
				overdue: false,
				version: 1,
			})
			expect(await statusOf(viewerApi.tasks.create({ dealId, title: 'No', dueOn: '2026-11-03' }))).toBe(403)
			expect(await statusOf(outsiderApi.tasks.create({ dealId, title: 'No', dueOn: '2026-11-03' }))).toBe(403)
			expect((await outsiderApi.tasks.list({})).items).toEqual([])
		})

		test('a task is assigned to a member of the org, under the directory’s label; an outsider or a forged label is refused', async () => {
			const dealId = await newDeal(await newCompany('Delegate'), 'Hand over')
			const { id } = await salesApi.tasks.create({ dealId, title: 'Approve', dueOn: '2026-11-04', assignee: managerCaller.id })
			expect((await viewerApi.tasks.list({})).items.find((item) => item.id === id)).toMatchObject({
				assignee: managerCaller.id,
				assigneeLabel: 'mia@acme.example',
			})
			expect(await statusOf(salesApi.tasks.create({ dealId, title: 'No', dueOn: '2026-11-04', assignee: outsider.id }))).toBe(400)
			expect(await statusOf(salesApi.tasks.create({ dealId, title: 'No', dueOn: '2026-11-04', assignee: 'user:nobody' }))).toBe(400)
			const forged = await kit.browser(sales)('/api/tasks.create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ dealId, title: 'No', dueOn: '2026-11-04', assignee: managerCaller.id, assigneeLabel: 'boss@acme.example' }),
			})
			expect(forged.status).toBe(400)
			expect((await viewerApi.tasks.list({})).items.filter((item) => item.dealId === dealId)).toHaveLength(1)
		})

		test('sales complete a task; a viewer and another org cannot', async () => {
			const dealId = await newDeal(await newCompany('Done Co'), 'Close')
			const { id } = await salesApi.tasks.create({ dealId, title: 'Send contract', dueOn: '2026-10-20' })
			expect(await statusOf(viewerApi.tasks.complete({ id, done: true, expectVersion: 1 }))).toBe(403)
			expect(await statusOf(outsiderApi.tasks.complete({ id, done: true, expectVersion: 1 }))).toBe(404)
			expect(await salesApi.tasks.complete({ id, done: true, expectVersion: 1 })).toEqual({ id, version: 2 })
			expect((await viewerApi.tasks.list({})).items.find((item) => item.id === id)?.done).toBe(true)
		})

		test('the hourly job marks an open task past its due day, and neither a done one nor one due later', async () => {
			const dealId = await newDeal(await newCompany('Late Ltd'), 'Overdue')
			const late = await salesApi.tasks.create({ dealId, title: 'Late', dueOn: '2020-01-01' })
			const finished = await salesApi.tasks.create({ dealId, title: 'Finished', dueOn: '2020-01-01' })
			await salesApi.tasks.complete({ id: finished.id, done: true, expectVersion: 1 })
			const later = await salesApi.tasks.create({ dealId, title: 'Later', dueOn: '2999-01-01' })
			expect(await kit.runJob('overdue')).toEqual({ status: 'succeeded', attempts: 1 })
			const overdue = new Map((await viewerApi.tasks.list({})).items.map((item) => [item.id, item.overdue]))
			expect([overdue.get(late.id), overdue.get(finished.id), overdue.get(later.id)]).toEqual([true, false, false])
		})
	})

	describe('activities', () => {
		test('sales log a call on a contact and a note on a deal; viewers read them but cannot log', async () => {
			const companyId = await newCompany('Chatty')
			const { id: contactId } = await manager.contacts.create({ companyId, name: 'Carol' })
			const dealId = await newDeal(companyId, 'Upsell')
			await salesApi.activities.logContact({ contactId, kind: 'call', body: 'Interested in the upsell' })
			await salesApi.activities.logDeal({ dealId, kind: 'note', body: 'Budget approved' })

			const onContact = (await viewerApi.activities.ofContact({ contactId })).items
			expect(onContact.map((item) => [item.kind, item.body, item.authorLabel])).toEqual([['call', 'Interested in the upsell', SALES_LABEL]])
			expect((await viewerApi.activities.ofDeal({ dealId })).items.map((item) => item.body)).toEqual(['Budget approved'])

			expect(await statusOf(viewerApi.activities.logContact({ contactId, kind: 'note', body: 'No' }))).toBe(403)
			expect(await statusOf(viewerApi.activities.logDeal({ dealId, kind: 'note', body: 'No' }))).toBe(403)
			expect(await statusOf(outsiderApi.activities.ofDeal({ dealId }))).toBe(404)
			expect(await statusOf(outsiderApi.activities.logDeal({ dealId, kind: 'note', body: 'No' }))).toBe(404)
		})
	})

	describe('attachments', () => {
		const uploadAs = (caller: TestCaller, dealId: string) =>
			kit.browser(caller)(`/api/files.attachments.upload/${dealId}?name=quote.txt`, {
				method: 'POST',
				headers: { 'Content-Type': 'text/plain' },
				body: 'quote: 1000 EUR',
			})
		const removeAs = (caller: TestCaller, fileId: string) =>
			kit.browser(caller)('/api/files.attachments.remove', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: fileId }),
			})

		test('sales attach a file to a deal and the org downloads it; a viewer cannot upload; another org reaches nothing', async () => {
			const dealId = await newDeal(await newCompany('Files Ltd'), 'With a quote')
			const stored = objects.objects.size
			expect((await uploadAs(viewer, dealId)).status).toBe(403)
			expect((await uploadAs(outsider, dealId)).status).toBe(404)
			expect(objects.objects.size).toBe(stored)

			const upload = await uploadAs(sales, dealId)
			expect(upload.status).toBe(200)
			const fileId = Uploaded.parse(await upload.json()).result.id
			const download = await kit.browser(viewer)(`/api/files.attachments/${fileId}`)
			expect(download.status).toBe(200)
			expect(await download.text()).toBe('quote: 1000 EUR')
			expect((await kit.browser(outsider)(`/api/files.attachments/${fileId}`)).status).toBe(404)
		})

		test('only a manager removes an attachment', async () => {
			const dealId = await newDeal(await newCompany('Removals'), 'Old quote')
			const fileId = Uploaded.parse(await (await uploadAs(sales, dealId)).json()).result.id
			expect((await removeAs(sales, fileId)).status).toBe(403)
			expect((await removeAs(outsider, fileId)).status).toBe(404)
			expect((await removeAs(inOrg('manager'), fileId)).status).toBe(200)
			expect((await kit.browser(sales)(`/api/files.attachments/${fileId}`)).status).toBe(404)
		})
	})

	describe('callers', () => {
		test('without a credential the proxy sends the caller to sign in; a script key is not a caller of the API', async () => {
			const answer = await kit.fetch('/api/companies.list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
			expect(answer.status).toBe(302)
			const script = kit.testCaller([{ role: 'viewer', scope: { type: 'org', value: 'acme' } }], { kind: 'machine' })
			if (script.key === null) throw new Error('a machine caller presents a key')
			expect(await statusOf(createClient(contract, 'api', { fetch: kit.fetch, key: script.key }).companies.list({}))).toBe(403)
		})
	})
}
