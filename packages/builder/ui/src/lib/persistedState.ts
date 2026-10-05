import { annotationSchema } from '@fabrika/annotations/schemas'
import { feedbackEntrySchema, parsePersistedState, persistedStateSchema, planResponseSchema } from '@fabrika/canvas-kernel/client'
import { z } from 'zod'

// Builder admits the legacy draft shape before Canvas applies its per-entry recovery.
const builderDraftSchema = persistedStateSchema.extend({
	generalNote: z.string(),
	annotations: z.array(annotationSchema.pick({ id: true, snippet: true, note: true, createdAt: true }).passthrough()),
	responses: z.array(z.tuple([
		z.string(),
		planResponseSchema.innerType().pick({ id: true, type: true, label: true }).extend({ type: z.string() }).passthrough(),
	])),
	feedbackEntries: z.array(z.tuple([z.string(), feedbackEntrySchema.pick({ id: true, markdown: true }).passthrough()])).optional(),
})

export function parseBuilderPersistedState(value: unknown) {
	const result = builderDraftSchema.safeParse(value)
	return result.success ? parsePersistedState(result.data) : null
}
