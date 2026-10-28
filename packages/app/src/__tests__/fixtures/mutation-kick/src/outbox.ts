import { ConflictError } from '@fabrika/app'
import { app } from './app-kit'
import { Message, Queued, Reminder, Waiting } from './schemas'

export const outbox = app.group({ callers: ['human'] }, (r) => ({
	enqueue: r.mutation({ input: Message, output: Queued, access: { action: 'outbox.write', app: true }, sql: 'write', kicks: ['deliver'] })
		.handle(async ({ input, ctx }) => {
			const id = Bun.randomUUIDv7()
			await ctx.sql(Queued)`insert into outbox (id, body) values (${id}, ${input.body}) returning id`
			ctx.kick('deliver')
			return { id }
		}),
	refuse: r.mutation({ input: Message, output: Queued, access: { action: 'outbox.write', app: true }, sql: 'write', kicks: ['deliver'] })
		.handle(async ({ input, ctx }) => {
			await ctx.sql(Queued)`insert into outbox (id, body) values (${Bun.randomUUIDv7()}, ${input.body}) returning id`
			ctx.kick('deliver')
			throw new ConflictError('the message is refused after its insert')
		}),
	post: r.mutation({ input: Message, output: Queued, access: { action: 'outbox.write', app: true }, sql: 'write', kicks: ['deliver'] })
		.handle(async ({ input, ctx }) => {
			const id = Bun.randomUUIDv7()
			await ctx.sql(Queued)`insert into outbox (id, body) values (${id}, ${input.body}) returning id`
			if (input.body.startsWith('later')) return { id }
			ctx.kick('deliver')
			if (input.body === 'refused') throw new ConflictError('the message is refused after its kick')
			return { id }
		}),
	remind: r.mutation({ input: Reminder, output: Queued, access: { action: 'outbox.write', app: true }, sql: 'write', kicks: ['deliver'] })
		.handle(async ({ input, ctx }) => {
			const id = Bun.randomUUIDv7()
			await ctx.sql(Queued)`insert into outbox (id, body) values (${id}, ${input.body}) returning id`
			for (const at of input.at) ctx.kick('deliver', { at: new Date(at) })
			if (input.body === 'refused') throw new ConflictError('the reminder is refused after its kicks')
			return { id }
		}),
	peek: r.query({ output: Waiting, access: { action: 'outbox.read', app: true }, sql: 'read' })
		.handle(async ({ ctx }) => {
			const [row] = await ctx.sql(Waiting)`select count(*)::int as waiting from outbox`
			return { waiting: row?.waiting ?? 0 }
		}),
}))
