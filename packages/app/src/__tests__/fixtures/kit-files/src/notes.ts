// The notes' procedures and jobs over their file columns: a note's documents and attachments are rows of its child
// tables, each holding one file reference.

import { ConflictError } from '@fabrika/app'
import { file } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from './app-kit'
import { filesDeps } from './world'

const Versioned = z.strictObject({ id: z.uuid(), expectVersion: z.int().positive() })
const ById = z.strictObject({ id: z.uuid() })
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
const Added = z.strictObject({ id: z.uuid() })
const Count = z.strictObject({ files: z.int() })
const Title = z.strictObject({ title: z.string() })

/** A mail attaches at most this much of one file. */
export const MAIL_MAX_BYTES = 4096

export const notes = app.group({ callers: ['human'] }, (r) => ({
	upload: r.mutation({
		input: z.strictObject({ id: z.uuid(), file: file('documents') }),
		output: Added,
		access: { action: 'notes.write', on: 'note', from: 'id' },
	})
		.handle(({ input, ctx }) => ctx.db.target.note_documents.insert({ file: input.file })),
	attach: r.mutation({
		input: z.strictObject({ id: z.uuid(), file: file('attachments') }),
		output: Added,
		access: { action: 'notes.write', on: 'note', from: 'id' },
	})
		.handle(({ input, ctx }) => ctx.db.target.note_attachments.insert({ file: input.file })),
	submit: r.mutation({ input: Versioned, output: Saved, access: { action: 'notes.write', on: 'note', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			const page = await ctx.db.target.note_documents.list()
			if (!page.items.some((row) => row.file.status === 'live' || row.file.status === 'quarantined')) {
				throw new ConflictError('a note is submitted with a document')
			}
			return ctx.db.target.update({ title: 'submitted' }, { expectVersion: input.expectVersion })
		}),
	attached: r.query({ input: ById, output: Count, access: { action: 'notes.read', on: 'note', from: 'id' } })
		.handle(async ({ ctx }) => ({ files: (await ctx.db.target.note_attachments.list()).items.length })),
	clear: r.mutation({ input: ById, output: Count, access: { action: 'notes.delete', on: 'note', from: 'id' } })
		.handle(async ({ ctx }) => {
			const { items } = await ctx.db.target.note_attachments.list()
			for (const row of items) await ctx.db.target.note_attachments.remove(row.id)
			return { files: items.length }
		}),
	download: r.query({
		input: z.strictObject({ id: z.uuid(), document: z.uuid() }),
		output: file('documents'),
		access: { action: 'notes.read', on: 'note', from: 'id' },
	}).handle(async ({ input, ctx }) => (await ctx.db.target.note_documents.get(input.document)).file),
}))

export const share = app.link('/s', {
	spa: 'dist/share',
	dimension: 'note',
	grants: ['notes.read', 'notes.write'],
	issuedBy: 'notes.write',
	maxDays: 7,
	procedures: (l) => ({
		note: l.query({ output: Title, access: { action: 'notes.read' } }).handle(async ({ ctx }) => ({ title: (await ctx.db.target.get()).title })),
	}),
})

/** Mails every note's live documents; a quarantined one waits for its scan. */
export const mail = app.cron('0 6 * * *', { actions: ['notes.read'] })
	.handle(async ({ ctx }) => {
		const outbox = filesDeps.get()
		const page = await ctx.db.over(ctx.within('notes.read', 'workspace')).notes.list({ orderBy: [['id', 'asc']] })
		for (const note of page.items) {
			const reader = await ctx.ref('notes.read', 'note', note.id)
			const documents = await ctx.db.on(reader).note_documents.list()
			const live = documents.items.filter((row) => row.file.status === 'live')
			if (live.length === 0) continue
			const attachments = []
			for (const row of live) {
				const opened = await ctx.files.open(row.file, { maxBytes: MAIL_MAX_BYTES })
				attachments.push({ name: opened.name, type: opened.type, bytes: opened.bytes })
			}
			outbox.sent.push({ note: note.id, attachments })
		}
	})

/** Erases every note titled `erase me`: blanks its title and deletes the rows of its files, in one transaction per note. */
export const erase = app.cron('0 8 * * *', { actions: ['notes.read', 'notes.write', 'notes.delete'] })
	.handle(async ({ ctx }) => {
		const world = filesDeps.get()
		const notes = ctx.db.over(ctx.within('notes.read', 'workspace')).notes
		const page = await notes.list({ where: [['title', '=', 'erase me']], orderBy: [['id', 'asc']] })
		for (const note of page.items) {
			const writer = await ctx.ref('notes.write', 'note', note.id)
			const remover = await ctx.ref('notes.delete', 'note', note.id)
			await ctx.transaction(async (tx) => {
				const row = await tx.db.on(writer).getForUpdate()
				await tx.db.on(writer).update({ title: '' }, { expectVersion: row.version })
				for (const table of ['note_attachments', 'note_documents'] as const) {
					const { items } = await tx.db.on(remover)[table].list()
					for (const item of items) await tx.db.on(remover)[table].remove(item.id)
					world.removed.push(items.length)
				}
				if (world.failErase) throw new Error('the erasure stops before its transaction commits')
			})
		}
	})
