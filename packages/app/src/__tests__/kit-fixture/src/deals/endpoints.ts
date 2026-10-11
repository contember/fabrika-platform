import { ConflictError } from '@fabrika/app'
import { app } from '../app-kit'
import { ById, Deal, DealPage, OrgInput, Pipeline, PipelineRow, Product, ProductName, ReopenDeal, Saved, Share, Shared } from '../schemas'
import { canReopen } from './logic'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: Deal, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			const deal = await ctx.db.target.get()
			return { id: deal.id, title: deal.title, stage: deal.stage }
		}),
	list: r.query({ input: OrgInput, output: DealPage, access: { action: 'crm.read', over: 'org' } })
		.handle(async ({ ctx }) => {
			const page = await ctx.db.within.companies.list({ limit: 1 })
			return { items: page.items.map((company) => ({ id: company.id, title: company.name, stage: 'lead' as const })), next: page.next }
		}),
	reopen: r.mutation({ input: ReopenDeal, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			const deal = await ctx.db.target.getForUpdate()
			if (!canReopen(deal.stage)) {
				throw new ConflictError('only a won or lost deal reopens')
			}
			return ctx.db.target.update({ stage: 'proposal' }, { expectVersion: input.expectVersion })
		}),
	pipeline: r.query({ input: OrgInput, output: Pipeline, access: { action: 'crm.read', in: 'org', from: 'orgId' }, sql: 'read' })
		.handle(async ({ ctx }) => ({
			rows: await ctx.sql(PipelineRow)`select stage, count(*) as deals from deals where org_id = ${ctx.target.value} group by stage`,
		})),
	share: r.mutation({ input: Share, output: Shared, access: { action: 'deals.share', on: 'deal', from: 'id' }, issues: 'shared' })
		.handle(async ({ input, ctx }) => ({ url: (await ctx.links.issue(ctx.target, { mount: 'shared', days: input.days })).url })),
	product: r.query({ input: Product, output: ProductName, access: { member: true }, connect: ['catalog'] })
		.handle(async ({ input, ctx }) => {
			const product = await ctx.connect.catalog.get({ sku: input.sku })
			return { name: product.outcome === 'ok' ? (product.value?.name ?? null) : null }
		}),
}))
