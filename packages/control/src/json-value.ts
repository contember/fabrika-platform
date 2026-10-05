import type { JsonValue } from '@fabrika/provider-contract'
import { z } from 'zod'

// Entry tuples preserve JSON keys such as __proto__, which Zod's record parser omits.
export const jsonValueSchema: z.ZodType<JsonValue, z.ZodTypeDef, unknown> = z.lazy(() =>
	z.union([
		z.null(),
		z.string(),
		z.boolean(),
		z.number(),
		z.nan(),
		z.array(jsonValueSchema),
		z.preprocess(
			value => typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.entries(value) : value,
			z.array(z.tuple([z.string(), jsonValueSchema])).transform(entries => Object.fromEntries(entries)),
		),
	])
)
