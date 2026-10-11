import { z } from 'zod/v4'
import { app } from './app-kit'

const Closed = z.strictObject({ id: z.uuid() })

export const close = app.cron('0 3 * * *', { actions: ['crm.read', 'deals.write'], scope: 'app', sql: 'write' })
	.handle(async ({ ctx }) => {
		const companies = await ctx.db.over(ctx.within('crm.read', 'org')).companies.count()
		if (companies > 0) {
			await ctx.transaction((tx) => tx.sql(Closed)`update deals set stage = 'lost' where stage = 'lead' returning id`)
		}
	})
