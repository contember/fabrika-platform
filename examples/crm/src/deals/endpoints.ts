import { ConflictError, fromPage, fromRow } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { picked } from '../orgs/logic'
import { ById, ClearableText, Done, MaybeText, Name, Next, OptionalText, Page, PrincipalId, Saved, Stage, Versioned } from '../schemas'
import { isClosed, pipelineOf } from './logic'

const Deal = z.strictObject({
	id: z.uuid(),
	companyId: z.uuid(),
	title: z.string(),
	value: z.int(),
	stage: Stage,
	source: MaybeText,
	owner: z.string(),
	ownerLabel: z.string(),
	version: z.int(),
})
const DealPage = z.strictObject({ items: z.array(Deal), next: Next })
const NewDeal = z.strictObject({ companyId: z.uuid(), title: Name, value: z.int().min(0), source: OptionalText })
const EditDeal = z.strictObject({ id: z.uuid(), title: Name, value: z.int().min(0), source: ClearableText, expectVersion: z.int().positive() })
const MoveDeal = z.strictObject({ id: z.uuid(), stage: Stage, expectVersion: z.int().positive() })
const AssignDeal = z.strictObject({ id: z.uuid(), newOwner: PrincipalId, expectVersion: z.int().positive() })
const StageTotal = z.strictObject({ stage: Stage, count: z.int(), value: z.int() })
const Pipeline = z.strictObject({ stages: z.array(StageTotal) })

export const deals = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ input: Page, output: DealPage, access: { action: 'crm.read', over: 'company' } })
		.handle(async ({ input, ctx }) => fromPage(Deal, await ctx.db.within.deals.list({ orderBy: [['title', 'asc']], after: input.after }))),
	pipeline: r.query({ output: Pipeline, access: { action: 'crm.read', over: 'company' } })
		.handle(async ({ ctx }) => ({
			stages: pipelineOf(await ctx.db.within.deals.aggregate({ groupBy: ['stage'], count: true, sum: ['value'] })),
		})),
	get: r.query({ input: ById, output: Deal, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => fromRow(Deal, await ctx.db.target.get())),
	create: r.mutation({ input: NewDeal, output: Saved, access: { action: 'deals.write', in: 'company', from: 'companyId' } })
		.handle(({ input, ctx }) =>
			ctx.db.target.deals.insert({
				title: input.title,
				value: input.value,
				stage: 'lead',
				source: input.source ?? null,
				owner: ctx.principal.id,
				owner_label: ctx.principal.label,
			})
		),
	edit: r.mutation({ input: EditDeal, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(({ input: { expectVersion, ...deal }, ctx }) => ctx.db.target.update(deal, { expectVersion })),
	move: r.mutation({ input: MoveDeal, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			if (isClosed((await ctx.db.target.getForUpdate()).stage)) throw new ConflictError('a won or lost deal is reopened before it moves')
			return ctx.db.target.update({ stage: input.stage }, { expectVersion: input.expectVersion })
		}),
	reopen: r.mutation({ input: Versioned, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			if (!isClosed((await ctx.db.target.getForUpdate()).stage)) throw new ConflictError('only a won or lost deal reopens')
			return ctx.db.target.update({ stage: 'proposal' }, { expectVersion: input.expectVersion })
		}),
	assign: r.mutation({ input: AssignDeal, output: Saved, access: { action: 'deals.assign', on: 'deal', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			const owner = picked(await ctx.members.get(input.newOwner), 'new owner')
			return ctx.db.target.update({ owner: owner.principalId, owner_label: owner.label }, { expectVersion: input.expectVersion })
		}),
	remove: r.mutation({ input: Versioned, output: Done, access: { action: 'crm.delete', on: 'deal', from: 'id' } })
		.handle(({ input, ctx }) => ctx.db.target.remove({ expectVersion: input.expectVersion }).then(() => ({ id: ctx.target.value }))),
}))
