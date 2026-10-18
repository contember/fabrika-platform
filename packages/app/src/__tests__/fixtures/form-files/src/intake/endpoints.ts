// The intake job: each registration becomes a candidate, and the photo the form received with it becomes the
// candidate's, in the one transaction that consumes the registration. A known address creates nothing, so its photo
// is never attached: the sweep deletes it once its hold ends.

import { z } from 'zod/v4'
import { app } from '../app-kit'

const Queued = z.strictObject({ id: z.string(), email: z.string(), name: z.string(), photo: z.nullable(z.string()) })
const Id = z.strictObject({ id: z.string() })

export const intake = app.cron('* * * * *', {
	actions: ['candidates.process', 'candidates.attach'],
	scope: 'app',
	sql: 'write',
}).handle(async ({ ctx }) => {
	const queued = await ctx.transaction((tx) => tx.sql(Id)`select id from registrations order by received_at, id limit 50`)
	for (const { id } of queued) {
		await ctx.transaction(async (tx) => {
			const [row] = await tx.sql(Queued)`select id, email, name, photo from registrations where id = ${id} for update skip locked`
			if (row === undefined) {
				return
			}
			await tx.sql(Id)`delete from registrations where id = ${row.id} returning id`
			const [created] = await tx.sql(Id)`
				insert into candidates (id, email, name, created_by, version)
				values (${crypto.randomUUID()}, ${row.email}, ${row.name}, ${ctx.principal.id}, 1)
				on conflict (email) do nothing returning id`
			if (created !== undefined && row.photo !== null) {
				const candidate = await tx.ref('candidates.attach', 'candidate', created.id)
				await tx.files('photos').attach(candidate, row.photo)
			}
		})
	}
})
