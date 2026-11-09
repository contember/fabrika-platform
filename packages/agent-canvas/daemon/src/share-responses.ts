import { z } from 'zod'

/**
 * Structured answers a reviewer gives on a shared canvas: the wire shape the
 * shared page sends with its feedback and the share worker validates. Kept
 * apart from share-client.ts so the worker can import it without the
 * encryption helpers.
 */

export const MAX_SHARED_RESPONSES = 500
export const MAX_SHARED_RESPONSE_TEXT = 10_000
const responseText = z.string().max(MAX_SHARED_RESPONSE_TEXT)

/** A reviewer's answer to an input component (Choice, MultiChoice, UserInput, RangeInput) on the shared page. */
export const sharedResponseSchema = z.object({
	id: z.string().min(1).max(200),
	type: z.enum(['select', 'radio', 'checkbox', 'text', 'range']),
	label: z.string().max(1000),
	value: z.union([responseText, z.array(responseText).max(500), z.number(), z.null()]),
	note: responseText.optional(),
})
export type SharedResponse = z.infer<typeof sharedResponseSchema>
export const sharedResponsesSchema = z.array(sharedResponseSchema).max(MAX_SHARED_RESPONSES)

/**
 * The answered inputs of a draft, as the shared page sends them. A response
 * that does not fit the wire shape, or has neither a value nor a note, is
 * left out.
 */
export function answeredResponses(responses: readonly unknown[]): SharedResponse[] {
	return responses.flatMap((candidate) => {
		const parsed = sharedResponseSchema.safeParse(candidate)
		if (!parsed.success) return []
		const { value, note, ...rest } = parsed.data
		const answered = Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.trim() !== '' : value !== null
		const trimmedNote = note?.trim() ?? ''
		if (!answered && !trimmedNote) return []
		return [{ ...rest, value, ...(trimmedNote ? { note: trimmedNote } : {}) }]
	})
}
