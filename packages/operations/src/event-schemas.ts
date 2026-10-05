import { z } from 'zod'

const optionalText = z.string().optional().catch(undefined)
const optionalNumber = z.number().finite().optional().catch(undefined)
const optionalStrings = z.array(z.string()).optional().catch(undefined)

export const sentryFrameSchema = z.object({
	function: optionalText,
	filename: optionalText,
	module: optionalText,
	abs_path: optionalText,
	lineno: optionalNumber,
	colno: optionalNumber,
	in_app: z.boolean().optional().catch(undefined),
	pre_context: optionalStrings,
	context_line: optionalText,
	post_context: optionalStrings,
}).transform((frame) => ({
	...(frame.function === undefined ? {} : { function: frame.function }),
	...(frame.filename === undefined ? {} : { filename: frame.filename }),
	...(frame.module === undefined ? {} : { module: frame.module }),
	...(frame.abs_path === undefined ? {} : { absPath: frame.abs_path }),
	...(frame.lineno === undefined ? {} : { line: frame.lineno }),
	...(frame.colno === undefined ? {} : { column: frame.colno }),
	...(frame.in_app === undefined ? {} : { inApp: frame.in_app }),
	...(frame.pre_context === undefined ? {} : { preContext: frame.pre_context }),
	...(frame.context_line === undefined ? {} : { contextLine: frame.context_line }),
	...(frame.post_context === undefined ? {} : { postContext: frame.post_context }),
}))

export const sentryFramesSchema = z.array(sentryFrameSchema.nullable().catch(null))
	.catch([]).transform((frames) => frames.filter((frame) => frame !== null))

export const sentryExceptionSchema = z.object({
	type: optionalText,
	value: optionalText,
	mechanism: z.object({ handled: z.boolean().nullable().catch(null) }).nullable().catch(null),
	stacktrace: z.object({ frames: sentryFramesSchema }).nullable().catch(null),
})

export const sentryBreadcrumbSchema = z.object({
	timestamp: z.union([z.string(), z.number()]).optional().catch(undefined),
	type: optionalText,
	category: optionalText,
	level: optionalText,
	message: optionalText,
}).transform((value) => ({
	...(value.timestamp === undefined ? {} : { timestamp: value.timestamp }),
	...(value.type === undefined ? {} : { type: value.type }),
	...(value.category === undefined ? {} : { category: value.category }),
	...(value.level === undefined ? {} : { level: value.level }),
	...(value.message === undefined ? {} : { message: value.message }),
}))

export const sentryRequestSchema = z.object({ url: optionalText, method: optionalText })
export const sentryUserSchema = z.object({
	id: z.union([z.string(), z.number()]).transform(String).nullable().catch(null),
	email: z.string().nullable().catch(null),
	username: z.string().nullable().catch(null),
})
export const sentryRuntimeSchema = z.object({ name: optionalText, version: optionalText })

export const envelopeItemSchema = z.object({ type: z.string().min(1), length: z.number().int().safe().nonnegative().optional() })
