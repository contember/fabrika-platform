import { ConflictError, fromPage } from '@fabrika/app'
import { file } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Cursor, Done, MAX_ATTACHMENTS_PER_DEAL, Name, Next } from '../schemas'

const FileInfo = z.strictObject({
	id: z.uuid(),
	name: z.nullable(z.string()),
	type: z.string(),
	size: z.int(),
	status: z.enum(['pending', 'quarantined', 'live', 'rejected']),
})
const Attachment = z.strictObject({ id: z.uuid(), name: z.string(), file: FileInfo, createdAt: z.iso.datetime() })
const AttachmentPage = z.strictObject({ items: z.array(Attachment), next: Next })
const OfDeal = z.strictObject({ dealId: z.uuid(), after: Cursor.optional() })
const OneAttachment = z.strictObject({ dealId: z.uuid(), id: z.uuid() })

export const attachments = app.group({ callers: ['human'] }, (r) => ({
	upload: r.mutation({
		input: z.strictObject({ dealId: z.uuid(), name: Name, file: file('attachments') }),
		output: Done,
		access: {
			capabilities: {
				deal: { action: 'deals.write', on: 'deal', from: 'dealId' },
				attached: { action: 'crm.read', on: 'deal', from: 'dealId' },
			},
		},
	}).handle(async ({ input, ctx }) => {
		// The deal's lock orders concurrent uploads, so the count cannot pass the limit.
		await ctx.db.on(ctx.capabilities.deal).getForUpdate()
		const held = await ctx.db.on(ctx.capabilities.attached).deal_attachments.list({ limit: MAX_ATTACHMENTS_PER_DEAL })
		if (held.items.length >= MAX_ATTACHMENTS_PER_DEAL) {
			throw new ConflictError(`a deal holds at most ${MAX_ATTACHMENTS_PER_DEAL} attachments`)
		}
		return ctx.db.on(ctx.capabilities.deal).deal_attachments.insert({ file: input.file, name: input.name })
	}),
	list: r.query({ input: OfDeal, output: AttachmentPage, access: { action: 'crm.read', on: 'deal', from: 'dealId' } })
		.handle(async ({ input, ctx }) =>
			fromPage(Attachment, await ctx.db.target.deal_attachments.list({ orderBy: [['created_at', 'asc']], after: input.after }))
		),
	download: r.query({ input: OneAttachment, output: file('attachments'), access: { action: 'crm.read', on: 'deal', from: 'dealId' } })
		.handle(async ({ input, ctx }) => (await ctx.db.target.deal_attachments.get(input.id)).file),
	remove: r.mutation({ input: OneAttachment, output: Done, access: { action: 'crm.delete', on: 'deal', from: 'dealId' } })
		.handle(({ input, ctx }) => ctx.db.target.deal_attachments.remove(input.id).then(() => ({ id: input.id }))),
}))
