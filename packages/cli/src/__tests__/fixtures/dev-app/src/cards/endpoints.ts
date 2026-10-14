import { fromRow } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'

const Card = z.strictObject({ id: z.uuid(), title: z.string() })
const CardList = z.strictObject({ items: z.array(Card) })
const NewCard = z.strictObject({ boardId: z.string().min(1).max(100), title: z.string().min(1).max(200) })
const ById = z.strictObject({ id: z.uuid() })
const Done = z.strictObject({ id: z.uuid() })
const Shared = z.strictObject({ url: z.string() })
const Invite = z.strictObject({ boardId: z.string().min(1).max(100), email: z.email() })
const Invited = z.strictObject({ invitationId: z.string() })

export const cards = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({ output: CardList, access: { action: 'cards.read', over: 'board' } })
		.handle(async ({ ctx }) => ({ items: (await ctx.db.within.cards.list({ orderBy: [['title', 'asc']] })).items.map((row) => fromRow(Card, row)) })),
	create: r.mutation({ input: NewCard, output: Done, access: { action: 'cards.write', in: 'board', from: 'boardId' } })
		.handle(({ input, ctx }) => ctx.db.target.cards.insert({ title: input.title })),
	share: r.mutation({ input: ById, output: Shared, access: { action: 'cards.share', on: 'card', from: 'id' }, issues: 'shared' })
		.handle(async ({ ctx }) => ({ url: (await ctx.links.issue(ctx.target, { mount: 'shared', days: 7 })).url })),
}))

export const boards = app.group({ callers: ['human'] }, (r) => ({
	invite: r.mutation({ input: Invite, output: Invited, access: { action: 'members.manage', in: 'board', from: 'boardId' } })
		.handle(async ({ input, ctx }) => {
			const result = await ctx.members.assign(ctx.target, { email: input.email }, 'member')
			return { invitationId: 'invited' in result ? result.invited.invitationId : result.assigned.principalId }
		}),
}))

export const shared = app.link('/s', {
	spa: 'site-share',
	dimension: 'card',
	grants: ['cards.read'],
	issuedBy: 'cards.share',
	maxDays: 30,
	procedures: (l) => ({
		card: l.query({ output: Card, access: { action: 'cards.read' } })
			.handle(async ({ ctx }) => fromRow(Card, await ctx.db.target.get())),
	}),
})
