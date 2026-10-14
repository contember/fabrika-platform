// The notes' endpoints and jobs over `ctx.files`. A mutation that writes a note lists its documents with its own
// `notes.write`, the collections' write action; a job opens a file with `notes.read`, their read action.

import { ConflictError } from '@fabrika/app'
import { z } from 'zod/v4'
import { app } from './app-kit'
import { filesDeps } from './world'

const Versioned = z.strictObject({ id: z.uuid(), expectVersion: z.int().positive() })
const ById = z.strictObject({ id: z.uuid() })
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
const Count = z.strictObject({ files: z.int() })
const Title = z.strictObject({ title: z.string() })

/** A mail attaches at most this much of one file. */
export const MAIL_MAX_BYTES = 4096

export const notes = app.group({ callers: ['human'] }, (r) => ({
	submit: r.mutation({ input: Versioned, output: Saved, access: { action: 'notes.write', on: 'note', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			const page = await ctx.files('documents').list(ctx.target)
			if (!page.items.some((file) => file.status === 'live' || file.status === 'quarantined')) {
				throw new ConflictError('a note is submitted with a document')
			}
			return ctx.db.target.update({ title: 'submitted' }, { expectVersion: input.expectVersion })
		}),
	attached: r.query({ input: ById, output: Count, access: { action: 'notes.read', on: 'note', from: 'id' } })
		.handle(async ({ ctx }) => ({ files: (await ctx.files('attachments').list(ctx.target)).items.length })),
	clear: r.mutation({ input: ById, output: Count, access: { action: 'notes.delete', on: 'note', from: 'id' } })
		.handle(async ({ ctx }) => ({ files: await ctx.files('attachments').removeAll(ctx.target) })),
	// notes.delete is neither a read nor a write action of documents: this query's capability does not list it.
	peek: r.query({ input: ById, output: Count, access: { action: 'notes.delete', on: 'note', from: 'id' } })
		.handle(async ({ ctx }) => ({ files: (await ctx.files('documents').list(ctx.target)).items.length })),
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
export const mail = app.cron('0 6 * * *', { actions: ['notes.read'], scope: 'app' })
	.handle(async ({ ctx }) => {
		const outbox = filesDeps.get()
		const page = await ctx.db.over(ctx.within('notes.read', 'workspace')).notes.list({ orderBy: [['id', 'asc']] })
		for (const note of page.items) {
			const owner = await ctx.ref('notes.read', 'note', note.id)
			const documents = ctx.files('documents')
			const live = (await documents.list(owner)).items.filter((file) => file.status === 'live')
			if (live.length === 0) continue
			const attachments = []
			for (const file of live) {
				const opened = await documents.open(owner, file.id, { maxBytes: MAIL_MAX_BYTES })
				attachments.push({ name: opened.name, type: opened.type, bytes: opened.bytes })
			}
			outbox.sent.push({ note: note.id, attachments })
		}
	})

/** Tries what `ctx.files` refuses, and records each refusal by its step. */
export const peek = app.cron('0 7 * * *', { actions: ['notes.read', 'notes.write', 'notes.delete'], scope: 'app' })
	.handle(async ({ ctx }) => {
		const world = filesDeps.get()
		const refused = (step: string) => (error: unknown) => {
			world.refusals.push({ step, error })
		}
		const documents = ctx.files('documents')
		const page = await ctx.db.over(ctx.within('notes.read', 'workspace')).notes.list({ orderBy: [['id', 'asc']] })
		const earlier: string[] = []
		for (const note of page.items) {
			const reader = await ctx.ref('notes.read', 'note', note.id)
			const writer = await ctx.ref('notes.write', 'note', note.id)
			const remover = await ctx.ref('notes.delete', 'note', note.id)
			await documents.list(remover).catch(refused('list with notes.delete'))
			for (const id of earlier) {
				await documents.open(reader, id, { maxBytes: MAIL_MAX_BYTES }).catch(refused('open of another note'))
			}
			for (const file of (await documents.list(writer)).items) {
				await documents.open(writer, file.id, { maxBytes: MAIL_MAX_BYTES }).catch(refused('open with notes.write'))
				await documents.open(reader, file.id, { maxBytes: MAIL_MAX_BYTES }).catch(refused(`open ${file.status}`))
				earlier.push(file.id)
			}
			for (const file of (await ctx.files('attachments').list(reader)).items) {
				await ctx.files('attachments').open(reader, file.id, { maxBytes: 1 }).catch(refused('open over maxBytes'))
			}
		}
		try {
			ctx.files('missing')
		} catch (error) {
			refused('an unknown collection')(error)
		}
	})

/** Erases every note titled `erase me`: blanks its title and removes its files, in one transaction per note. */
export const erase = app.cron('0 8 * * *', { actions: ['notes.read', 'notes.write', 'notes.delete'], scope: 'app' })
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
				world.removed.push(await tx.files('attachments').removeAll(remover), await tx.files('documents').removeAll(remover))
				if (world.failErase) throw new Error('the erasure stops before its transaction commits')
			})
		}
	})
