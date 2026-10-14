// The members of a workspace as its lead manages them, through the kit's own IAM: an invitation its addressee accepts, a
// member the lead removes. Each allowed call has a refused twin. It boots a data layer of its own, beside the generated
// endpoint access test's, because a layer binds once per process.

import { createClient } from '@fabrika/app/client'
import { serve } from '@fabrika/app/implement'
import { statusOf, type TestCaller, testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from '../../fabrika.contract'
import { tables } from '../db/tables'

const postgres = await testDatabase({ migrations: new URL('../../db/migrations/', import.meta.url), label: 'members.test.ts' })

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
	const apiOf = (caller: TestCaller) => createClient(contract, 'api', { fetch: kit.browser(caller) })
	// One workspace row, in an organization of its own; the contract has no endpoint that creates one.
	const id = (await postgres.seedWorlds(tables, 'workspaces')).own.key
	const workspace = kit.scope('workspace', id)
	const lead = kit.testCaller([{ role: 'lead', scope: workspace }])
	const leadApi = apiOf(lead)

	describe('workspace members', () => {
		test('a lead invites; the addressee accepts and is a member; the lead removes it, and it is refused from then on', async () => {
			const { invitationId } = await leadApi.workspaces.invite({ id, email: 'ann@example.test', role: 'editor' })
			const ann = kit.acceptInvitation(invitationId)
			const annApi = apiOf(ann)
			expect((await annApi.workspaces.members({ id })).items).toContainEqual({ principalId: ann.id, roles: ['editor'] })

			expect(await leadApi.workspaces.remove({ id, principalId: ann.id })).toEqual({ id })
			expect(await statusOf(annApi.workspaces.members({ id }))).toBe(403)
			expect((await leadApi.workspaces.members({ id })).items).toEqual([{ principalId: lead.id, roles: ['lead'] }])
		})

		test('an editor invites and removes nobody; a lead of another workspace finds no workspace here (404)', async () => {
			const editor = kit.testCaller([{ role: 'editor', scope: workspace }])
			expect(await statusOf(apiOf(editor).workspaces.invite({ id, email: 'bob@example.test', role: 'editor' }))).toBe(403)
			expect(await statusOf(apiOf(editor).workspaces.remove({ id, principalId: lead.id }))).toBe(403)
			const elsewhere = apiOf(kit.testCaller([{ role: 'lead', scope: kit.scope('workspace', 'w2') }]))
			expect(await statusOf(elsewhere.workspaces.remove({ id, principalId: editor.id }))).toBe(404)
			expect((await leadApi.workspaces.members({ id })).items.map((item) => item.principalId)).toContain(editor.id)
		})
	})
}
