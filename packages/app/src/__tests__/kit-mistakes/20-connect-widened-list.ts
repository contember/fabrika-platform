import { app } from '../kit-fixture/src/app-kit'
import { Ok } from '../kit-fixture/src/schemas'

const declared: readonly 'catalog'[] = []

export const products = app.group({ callers: ['human'] }, (r) => ({
	// mistake: a list typed by its element may hold no connector at all; the declaration names them as a literal
	get: r.query({ output: Ok, access: { member: true }, connect: declared })
		.handle(async ({ ctx }) => {
			await ctx.connect.catalog.get({ sku: 'x' })
			return { ok: true }
		}),
}))
