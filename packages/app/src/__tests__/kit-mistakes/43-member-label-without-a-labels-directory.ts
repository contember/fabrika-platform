import { app } from '../kit-fixture/src/app-kit'
import { Me, OrgInput } from '../kit-fixture/src/schemas'

export const orgs = app.group({ callers: ['human'] }, (r) => ({
	me: r.query({ input: OrgInput, output: Me, access: { action: 'crm.read', in: 'org', from: 'orgId' } })
		.handle(async ({ ctx }) => {
			const member = await ctx.members.get(ctx.principal.id)
			// mistake: org declares no directory: 'labels', so IAM answers a label only to a members.manage holder
			return { label: member === null ? '' : member.label.toLowerCase() }
		}),
}))
