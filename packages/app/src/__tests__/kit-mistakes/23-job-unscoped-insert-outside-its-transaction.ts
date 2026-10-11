import { app } from '../kit-fixture/src/app-kit'

export const seed = app.cron('0 * * * *', { actions: ['crm.write'], scope: 'app', unscoped: { companies: 'write' } })
	.handle(async ({ ctx }) => {
		// mistake: the table is declared 'write', and a job still writes it inside ctx.transaction
		await ctx.db.unscoped.companies.insert({ name: 'x', org_id: 'org' })
	})
