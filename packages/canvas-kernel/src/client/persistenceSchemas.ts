import { annotationStateSchema } from '@fabrika/annotations/schemas'
import { z } from 'zod'

export const planResponseSchema = z.object({
	id: z.string(),
	type: z.enum(['select', 'radio', 'checkbox', 'text', 'range']),
	label: z.string(),
	value: z.unknown(),
	options: z.array(z.string()).optional(),
	required: z.boolean().optional(),
	note: z.string().optional(),
}).passthrough().transform(response => ({ ...response, value: response.value }))

export const feedbackEntrySchema = z.object({
	id: z.string(),
	markdown: z.string(),
	label: z.string().optional(),
	required: z.boolean().optional(),
}).passthrough()

export const persistedStateSchema = annotationStateSchema.extend({
	responses: z.array(
		z.tuple([z.string(), planResponseSchema]).optional().catch(undefined),
	)
		.transform(entries => entries.filter(entry => entry !== undefined)).catch([]),
	feedbackEntries: z.array(
		z.tuple([z.string(), feedbackEntrySchema]).optional().catch(undefined),
	)
		.transform(entries => entries.filter(entry => entry !== undefined)).optional().catch([]),
})

export function parsePersistedState(value: unknown) {
	const result = persistedStateSchema.safeParse(value)
	return result.success ? result.data : null
}

export const feedbackResponseSchema = z.object({ feedback: z.string().nullish() })
export const filePreviewResponseSchema = z.union([
	z.object({ error: z.string().min(1) }),
	z.object({ content: z.string(), language: z.string().nullish() }),
])
