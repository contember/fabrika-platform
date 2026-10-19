// The link mounts of a candidate: `portal`, whose links the intake job e-mails and whose holder attaches files to its
// own record, and `review`, a second mount on the same dimension whose keys reach only their own routes.

import { NotFoundError } from '@fabrika/app'
import { file } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Me, Verified } from '../schemas'

const Attached = z.strictObject({ id: z.uuid() })
const Documents = z.strictObject({ items: z.array(z.strictObject({ id: z.uuid(), name: z.nullable(z.string()), status: z.string() })) })

export const portal = app.link('/p', {
	spa: 'dist/portal',
	dimension: 'candidate',
	grants: ['candidates.read', 'candidates.verify', 'candidates.attach'],
	issuedBy: 'candidates.invite',
	maxDays: 7,
	procedures: (l) => ({
		me: l.query({ output: Me, access: { action: 'candidates.read' } }).handle(async ({ ctx }) => {
			const row = await ctx.db.target.get()
			return { name: row.name, email: row.email, verified: row.verified_at !== null }
		}),
		// Single use is application state: the first call sets verified_at, every later one answers it unchanged.
		verify: l.mutation({ output: Verified, access: { action: 'candidates.verify' } }).handle(async ({ ctx }) => {
			const row = await ctx.db.target.getForUpdate()
			if (row.verified_at !== null) {
				return { verifiedAt: new Date(row.verified_at).toISOString() }
			}
			const now = new Date()
			await ctx.db.target.update({ verified_at: now }, { expectVersion: row.version })
			return { verifiedAt: now.toISOString() }
		}),
		attach: l.mutation({ input: z.strictObject({ file: file('attachments') }), output: Attached, access: { action: 'candidates.attach' } })
			.handle(async ({ input, ctx }) => {
				await ctx.db.target.candidate_files.insert({ file: input.file })
				return { id: input.file.id }
			}),
		documents: l.query({ output: Documents, access: { action: 'candidates.read' } }).handle(async ({ ctx }) => ({
			items: (await ctx.db.target.candidate_files.list()).items.map((row) => ({ id: row.file.id, name: row.file.name, status: row.file.status })),
		})),
		document: l.query({ input: z.strictObject({ id: z.uuid() }), output: file('attachments'), access: { action: 'candidates.read' } })
			.handle(async ({ input, ctx }) => {
				const row = (await ctx.db.target.candidate_files.list()).items.find((item) => item.file.id === input.id)
				if (row === undefined) throw new NotFoundError('no such document')
				return row.file
			}),
	}),
})

export const review = app.link('/r', {
	spa: 'dist/review',
	dimension: 'candidate',
	grants: ['candidates.read', 'candidates.attach'],
	issuedBy: 'candidates.invite',
	maxDays: 1,
	procedures: (l) => ({
		me: l.query({ output: Me, access: { action: 'candidates.read' } }).handle(async ({ ctx }) => {
			const row = await ctx.db.target.get()
			return { name: row.name, email: row.email, verified: row.verified_at !== null }
		}),
	}),
})
