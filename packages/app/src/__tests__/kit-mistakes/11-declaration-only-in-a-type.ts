import { app } from '../kit-fixture/src/app-kit'
import { Ok, Share } from '../kit-fixture/src/schemas'

const definition: {
	readonly input: typeof Share
	readonly output: typeof Ok
	readonly access: { readonly action: 'deals.share'; readonly on: 'deal'; readonly from: 'id' }
	readonly sql?: 'write'
} = { input: Share, output: Ok, access: { action: 'deals.share', on: 'deal', from: 'id' } }

export const deals = app.group({ callers: ['human'] }, (r) => ({
	// mistake: an annotation that allows sql declares nothing; ctx.sql exists only for a declaration the object carries
	share: r.mutation(definition)
		.handle(() => ({ ok: true })),
}))
