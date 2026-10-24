// `audit.list` with `changesOnly` leaves out the admin reads IAM writes for every `/admin/*` request, before the page
// is cut, so a feed of what changed pages through changes alone.

import { describe, expect, test } from 'bun:test'
import { ADMIN_ACCESS_ACTION } from '../admin/access'
import { prop } from '../json'
import { result } from './helpers/app-people'
import { TEST_BRAND } from './helpers/brand'
import { createHarness } from './helpers/harness'
import { membershipFixture } from './helpers/membership'

const SERVICES = { authentication: { oidc: false, password: true } }

interface Page {
	readonly actions: string[]
	readonly nextCursor: string | null
}

describe('audit.list with changesOnly', () => {
	test('pages through the changes alone, however many reads sit between them', async () => {
		const f = await membershipFixture(createHarness().repositories, { services: SERVICES })
		const list = async (input: Record<string, unknown>): Promise<Page> => {
			const body = result(await (await f.adminRpc('audit.list', input)).json())
			const items = prop(body, 'items')
			const cursor = prop(body, 'nextCursor')
			return {
				actions: Array.isArray(items) ? items.map((item) => String(prop(item, 'action'))) : [],
				nextCursor: typeof cursor === 'string' ? cursor : null,
			}
		}
		// Each call is an audited read; the two changes between them write one row each beside it.
		await f.adminRpc('brand.get', null)
		await f.adminRpc('brand.set', { brand: TEST_BRAND })
		await f.adminRpc('brand.get', null)
		await f.adminRpc('brand.get', null)
		await f.adminRpc('brand.clear', null)
		await f.adminRpc('brand.get', null)

		const first = await list({ changesOnly: true, limit: 1 })
		expect(first.actions).toEqual(['iam.brand.update'])
		expect(first.nextCursor).not.toBeNull()
		const second = await list({ changesOnly: true, limit: 1, before: first.nextCursor })
		expect(second.actions).toEqual(['iam.brand.update'])
		const rest = await list({ changesOnly: true, limit: 50, before: second.nextCursor })
		expect(rest.actions.filter((action) => action === ADMIN_ACCESS_ACTION)).toEqual([])
		expect(rest.actions).not.toContain('iam.brand.update')

		// Without it the reads are listed as before: the newest row is the access of this very list call.
		expect((await list({ limit: 1 })).actions).toEqual([ADMIN_ACCESS_ACTION])
	})
})
