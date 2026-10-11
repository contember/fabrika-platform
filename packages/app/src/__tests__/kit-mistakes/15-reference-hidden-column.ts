import { app } from '../kit-fixture/src/app-kit'
import { Me } from '../kit-fixture/src/schemas'

export const countries = app.group({ callers: ['human'] }, (r) => ({
	first: r.query({ output: Me, access: { member: true } })
		.handle(async ({ ctx }) => {
			const page = await ctx.db.reference.countries.list()
			// mistake: a reference table is read through its read action, and note declares another
			const note: string | null = page.items[0]?.note ?? null
			return { label: note ?? '' }
		}),
}))
