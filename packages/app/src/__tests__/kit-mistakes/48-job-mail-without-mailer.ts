import { app } from '../kit-fixture/src/app-kit'

export const welcome = app.cron('0 3 * * *', { actions: ['crm.read'] })
	.handle(async ({ ctx }) => {
		// mistake: a job sends mail only through the transport it declares with mailer: 'installation' or 'own'
		await ctx.mail.send({ to: 'ada@example.com', subject: 'Welcome', text: 'Hello', idempotencyKey: 'welcome-1' })
	})
