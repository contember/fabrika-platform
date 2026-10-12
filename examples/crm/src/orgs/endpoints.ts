// The orgs a caller works in, and the members of one: the people a deal's owner and a task's assignee are picked from.

import { z } from 'zod/v4'
import { app } from '../app-kit'
import { ScopeValue } from '../schemas'

const OrgList = z.strictObject({ orgs: z.array(z.string()) })
const OrgInput = z.strictObject({ orgId: ScopeValue })
const Members = z.strictObject({ items: z.array(z.strictObject({ principalId: z.string(), label: z.nullable(z.string()) })) })

export const orgs = app.group({ callers: ['human'] }, (r) => ({
	mine: r.query({ output: OrgList, access: { action: 'crm.read', over: 'org' } })
		.handle(({ ctx }) => ({ orgs: ctx.within.values === 'all' ? [] : [...ctx.within.values] })),
	members: r.query({ input: OrgInput, output: Members, access: { action: 'crm.read', in: 'org', from: 'orgId' } })
		.handle(async ({ ctx }) => ({
			items: (await ctx.members.list()).map((member) => ({ principalId: member.principalId, label: member.label })),
		})),
}))
