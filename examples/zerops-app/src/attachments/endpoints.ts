// The attachments of a note: rows of `note_attachments`, each holding a file of the `attachments` kind. The note's
// actions are the file's authority: who reads the note reads its files, and who may delete it removes them.

import { ConflictError, fromRow } from '@fabrika/app'
import { file } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Done, MAX_ATTACHMENTS_PER_NOTE } from '../schemas'

const FileInfo = z.strictObject({
	id: z.uuid(),
	name: z.nullable(z.string()),
	type: z.string(),
	size: z.int(),
	status: z.enum(['pending', 'quarantined', 'live', 'rejected']),
})
const Attachment = z.strictObject({ id: z.uuid(), file: FileInfo })
const AttachmentList = z.strictObject({ items: z.array(Attachment) })
const OfNote = z.strictObject({ noteId: z.uuid() })
const OneAttachment = z.strictObject({ noteId: z.uuid(), id: z.uuid() })

export const attachments = app.group({ callers: ['human', 'machine'] }, (r) => ({
	upload: r.mutation({
		input: z.strictObject({ noteId: z.uuid(), file: file('attachments') }),
		output: Done,
		access: {
			capabilities: {
				note: { action: 'notes.write', on: 'note', from: 'noteId' },
				attached: { action: 'notes.read', on: 'note', from: 'noteId' },
			},
		},
	}).handle(async ({ input, ctx }) => {
		// The note's lock orders concurrent uploads, so the count cannot pass the limit.
		await ctx.db.on(ctx.capabilities.note).getForUpdate()
		const held = await ctx.db.on(ctx.capabilities.attached).note_attachments.list({ limit: MAX_ATTACHMENTS_PER_NOTE })
		if (held.items.length >= MAX_ATTACHMENTS_PER_NOTE) {
			throw new ConflictError(`a note holds at most ${MAX_ATTACHMENTS_PER_NOTE} attachments`)
		}
		const { id } = await ctx.db.on(ctx.capabilities.note).note_attachments.insert({ file: input.file })
		return { id }
	}),
	list: r.query({ input: OfNote, output: AttachmentList, access: { action: 'notes.read', on: 'note', from: 'noteId' } })
		.handle(async ({ ctx }) => {
			const page = await ctx.db.target.note_attachments.list({ orderBy: [['created_at', 'asc']], limit: MAX_ATTACHMENTS_PER_NOTE })
			return { items: page.items.map((row) => fromRow(Attachment, row)) }
		}),
	download: r.query({ input: OneAttachment, output: file('attachments'), access: { action: 'notes.read', on: 'note', from: 'noteId' } })
		.handle(async ({ input, ctx }) => (await ctx.db.target.note_attachments.get(input.id)).file),
	remove: r.mutation({ input: OneAttachment, output: Done, access: { action: 'notes.delete', on: 'note', from: 'noteId' } })
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.note_attachments.remove(input.id)
			return { id: input.id }
		}),
}))
