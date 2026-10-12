import { BadRequestError, fromRow } from '@fabrika/app'
import { app } from '../app-kit'
import { AssignDeal, ById, Candidate, CompanyCandidate, Found, Owner, Saved, Team } from '../schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	owner: r.query({ input: ById, output: Owner, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => fromRow(Owner, await ctx.db.target.get())),
	// The org's member a person picked becomes the owner; the label is the directory's, never the input's.
	assign: r.mutation({ input: AssignDeal, output: Saved, access: { action: 'deals.assign', on: 'deal', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			const owner = await ctx.members.get(input.newOwner)
			if (owner === null) {
				throw new BadRequestError('the owner is not a member of the org')
			}
			return ctx.db.target.update({ owner: owner.principalId, owner_label: owner.label }, { expectVersion: input.expectVersion })
		}),
	candidate: r.query({ input: Candidate, output: Found, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			const member = await ctx.members.get(input.principalId)
			return { member: member === null ? null : { principalId: member.principalId, label: member.label } }
		}),
	// The same lookup from a company: the org it lies in.
	check: r.query({ input: CompanyCandidate, output: Found, access: { action: 'crm.read', in: 'company', from: 'companyId' } })
		.handle(async ({ input, ctx }) => {
			const member = await ctx.members.get(input.principalId)
			return { member: member === null ? null : { principalId: member.principalId, label: member.label } }
		}),
	team: r.query({ input: ById, output: Team, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => ({
			members: (await ctx.members.list()).map((member) => ({ principalId: member.principalId, label: member.label })),
		})),
}))
