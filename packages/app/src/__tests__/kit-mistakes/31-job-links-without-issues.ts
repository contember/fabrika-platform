import { app } from '../kit-fixture/src/app-kit'

export const invite = app.cron('* * * * *', { actions: ['crm.read', 'deals.share'], scope: 'app' })
	.handle(async ({ ctx }) => {
		const deal = await ctx.ref('deals.share', 'deal', 'id')
		// mistake: a job issues share links only for the mount it declares with issues: '<link mount>'
		await ctx.links.issue(deal, { mount: 'shared', days: 3 })
	})
