import { app } from '../fixtures/visitor-intake/src/app-kit'

export const drain = app.cron('* * * * *', { actions: ['candidates.process'], scope: 'app', unscoped: { registrations: 'read' } })
	.handle(async ({ ctx }) => {
		// mistake: a form's inbox has no key, so no row is read by one
		await ctx.db.unscoped.registrations.get('r1')
	})
