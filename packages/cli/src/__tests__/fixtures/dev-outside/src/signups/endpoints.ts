import { z } from 'zod/v4'
import { app } from '../app-kit'
import { mailer } from '../mail'

const Requested = z.strictObject({ email: z.string() })

export const welcome = app.cron('0 * * * *', { actions: ['signups.process'], scope: 'app', retries: 0, sql: 'read' })
	.handle(async ({ ctx }) => {
		const rows = await ctx.transaction((tx) => tx.sql(Requested)`select email from requests order by email`)
		for (const row of rows) await mailer.get().send(row.email, ctx.signal)
	})

export const broken = app.cron('0 3 * * *', { actions: ['signups.process'], scope: 'app', retries: 0 }).handle(() => {
	throw new Error('the broken job threw on purpose')
})
