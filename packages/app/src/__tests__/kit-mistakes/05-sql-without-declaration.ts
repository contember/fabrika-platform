import { app } from '../kit-fixture/src/app-kit'
import { OrgInput, Pipeline, PipelineRow } from '../kit-fixture/src/schemas'

export const reports = app.group({ callers: ['human'] }, (r) => ({
	pipeline: r.query({ input: OrgInput, output: Pipeline, access: { action: 'crm.read', in: 'org', from: 'orgId' } })
		.handle(async ({ ctx }) => ({
			// mistake: raw SQL is declared on the endpoint (sql: 'read'), so the approver sees it
			rows: await ctx.sql(PipelineRow)`select stage, count(*) as deals from deals where org_id = ${ctx.target.value} group by stage`,
		})),
}))
