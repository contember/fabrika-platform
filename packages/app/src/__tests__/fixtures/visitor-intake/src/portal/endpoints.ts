// The link mounts of a candidate: `portal`, whose links the intake job e-mails, and `review`, a second mount on the
// same dimension whose keys reach only their own routes.

import { app } from '../app-kit'
import { Me, Verified } from '../schemas'

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
