import { app } from '../kit-fixture/src/app-kit'
import { Company, OrgInput } from '../kit-fixture/src/schemas'

export const audit = app.group({ callers: ['human'] }, (r) => ({
	first: r.query({ input: OrgInput, output: Company, access: { action: 'crm.read', in: 'org', from: 'orgId' }, unscoped: { companies: 'read' } })
		.handle(async ({ ctx }) => {
			// mistake: only companies is declared unscoped; deals outside the scope needs its own declaration
			const page = await ctx.db.unscoped.deals.list()
			return { id: page.items[0]?.id ?? '', name: '' }
		}),
}))
