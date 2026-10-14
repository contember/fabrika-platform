// The caller document every SPA mount serves at `<prefix>/__fabrika-me.json`: who the page's person is and what the
// token says they hold. A page shows and hides by it; it decides nothing, because every endpoint checks again.

import { z } from 'zod/v4'

const ScopedActions = z.strictObject({ type: z.string(), value: z.string(), actions: z.array(z.string()) })

const PageCallerSchema = z.strictObject({
	label: z.string(),
	email: z.string(),
	actions: z.strictObject({
		/** The actions held as a global grant, so in every value. */
		app: z.array(z.string()),
		/** Each scope value the person holds something in, with those actions; sorted by dimension, then value. */
		scopes: z.array(ScopedActions),
	}),
})

export type PageCaller = z.infer<typeof PageCallerSchema>

/** The caller document as the framework answers it; throws on any other value. */
export function parsePageCaller(value: unknown): PageCaller {
	return PageCallerSchema.parse(value)
}
