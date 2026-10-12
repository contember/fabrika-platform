import { fromPage } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { ActivityKind, Cursor, Done, Next } from '../schemas'

const Activity = z.strictObject({ id: z.uuid(), kind: ActivityKind, body: z.string(), authorLabel: z.string(), createdAt: z.iso.datetime() })
const ActivityPage = z.strictObject({ items: z.array(Activity), next: Next })
const Body = z.string().min(1).max(5000)
const OfContact = z.strictObject({ contactId: z.uuid(), after: Cursor.optional() })
const OfDeal = z.strictObject({ dealId: z.uuid(), after: Cursor.optional() })
const LogOnContact = z.strictObject({ contactId: z.uuid(), kind: ActivityKind, body: Body })
const LogOnDeal = z.strictObject({ dealId: z.uuid(), kind: ActivityKind, body: Body })

export const activities = app.group({ callers: ['human'] }, (r) => ({
	ofContact: r.query({ input: OfContact, output: ActivityPage, access: { action: 'crm.read', on: 'contact', from: 'contactId' } })
		.handle(async ({ input, ctx }) =>
			fromPage(Activity, await ctx.db.target.contact_activities.list({ orderBy: [['created_at', 'desc']], after: input.after }))
		),
	ofDeal: r.query({ input: OfDeal, output: ActivityPage, access: { action: 'crm.read', on: 'deal', from: 'dealId' } })
		.handle(async ({ input, ctx }) =>
			fromPage(Activity, await ctx.db.target.deal_activities.list({ orderBy: [['created_at', 'desc']], after: input.after }))
		),
	logContact: r.mutation({ input: LogOnContact, output: Done, access: { action: 'activities.write', on: 'contact', from: 'contactId' } })
		.handle(({ input, ctx }) => ctx.db.target.contact_activities.insert({ kind: input.kind, body: input.body, author_label: ctx.principal.label })),
	logDeal: r.mutation({ input: LogOnDeal, output: Done, access: { action: 'activities.write', on: 'deal', from: 'dealId' } })
		.handle(({ input, ctx }) => ctx.db.target.deal_activities.insert({ kind: input.kind, body: input.body, author_label: ctx.principal.label })),
}))
