import { ConflictError } from '@fabrika/app'
import { app } from './app-kit'
import { Message, Queued, Waiting } from './schemas'

export const outbox = app.group({ callers: ['human'] }, (r) => ({
	enqueue: r.mutation({ input: Message, output: Queued, access: { action: 'outbox.write', app: true }, sql: 'write', then: 'deliver' })
		.handle(async ({ input, ctx }) => {
			const id = Bun.randomUUIDv7()
			await ctx.sql(Queued)`insert into outbox (id, body) values (${id}, ${input.body}) returning id`
			return { id }
		}),
	refuse: r.mutation({ input: Message, output: Queued, access: { action: 'outbox.write', app: true }, sql: 'write', then: 'deliver' })
		.handle(async ({ input, ctx }) => {
			await ctx.sql(Queued)`insert into outbox (id, body) values (${Bun.randomUUIDv7()}, ${input.body}) returning id`
			throw new ConflictError('the message is refused after its insert')
		}),
	peek: r.query({ output: Waiting, access: { action: 'outbox.read', app: true }, sql: 'read' })
		.handle(async ({ ctx }) => {
			const [row] = await ctx.sql(Waiting)`select count(*)::int as waiting from outbox`
			return { waiting: row?.waiting ?? 0 }
		}),
}))
