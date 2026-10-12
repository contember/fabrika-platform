// The deals of a company and the pipeline across the caller's orgs. A won or lost deal is closed: `move` refuses it and
// `reopen` brings it back to `proposal`, both deciding on the stage they lock.

import { ConflictError, fromRow } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { ById, DEAL_STAGES, Done, MaybeText, Name, Next, OptionalText, Page, Person, Saved, Stage, Versioned } from '../schemas'
import { isClosed } from './logic'

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
const NewDeal = z.strictObject({ companyId: z.uuid(), title: Name, value: z.int().min(0), stage: Stage, source: OptionalText })
const EditDeal = z.strictObject({ id: z.uuid(), title: Name, value: z.int().min(0), source: OptionalText, expectVersion: z.int().positive() })
const MoveDeal = z.strictObject({ id: z.uuid(), stage: Stage, expectVersion: z.int().positive() })
const AssignDeal = z.strictObject({ id: z.uuid(), owner: Person, expectVersion: z.int().positive() })
const StageTotal = z.strictObject({ stage: Stage, count: z.int(), value: z.int() })
const Pipeline = z.strictObject({ stages: z.array(StageTotal) })

export const deals = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ input: Page, output: DealPage, access: { action: 'crm.read', over: 'company' } })
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.within.deals.list({ orderBy: [['title', 'asc']], after: input.after })
			return { items: page.items.map((row) => fromRow(Deal, row)), next: page.next }
		}),
	// Every stage in pipeline order, an empty one included, in one statement: the reason this report is SQL.
	pipeline: r.query({ output: Pipeline, access: { action: 'crm.read', over: 'org' }, sql: 'read' })
		.handle(async ({ ctx }) => ({
			stages: await ctx.sql(StageTotal)`
				select s.stage, count(d.id)::int as count, coalesce(sum(d.value), 0)::int as value
				from unnest(${[...DEAL_STAGES]}::deal_stage[]) as s (stage)
				left join deals d on d.stage = s.stage and ${ctx.sql.scope(ctx.within, 'deals', 'd')}
				group by s.stage
				order by s.stage`,
		})),
	get: r.query({ input: ById, output: Deal, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => fromRow(Deal, await ctx.db.target.get())),
	create: r.mutation({ input: NewDeal, output: Saved, access: { action: 'deals.write', in: 'company', from: 'companyId' } })
		.handle(({ input, ctx }) => ctx.db.target.deals.insert({ ...input, owner: ctx.principal.id, owner_label: ctx.principal.label })),
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
		.handle(({ input, ctx }) =>
			ctx.db.target.update({ owner: input.owner.principalId, owner_label: input.owner.label }, { expectVersion: input.expectVersion })
		),
	remove: r.mutation({ input: Versioned, output: Done, access: { action: 'crm.delete', on: 'deal', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.remove({ expectVersion: input.expectVersion })
			return { id: ctx.target.value }
		}),
}))
