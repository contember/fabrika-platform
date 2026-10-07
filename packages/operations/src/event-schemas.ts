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

// Ingest accepts a bare exception whose `type` key is present with any value, so the key's presence is kept.
const sentryEventExceptionSchema = sentryExceptionSchema.extend({
	type: z.unknown(),
	values: z.array(sentryExceptionSchema.nullable().catch(null)).optional().catch(undefined),
}).transform(({ type, ...exception }) => ({
	...exception,
	type: typeof type === 'string' ? type : undefined,
	hasTypeKey: type !== undefined,
}))

const sentryMessageSchema = z.union([
	z.string(),
	z.object({ formatted: optionalText, message: optionalText }).transform((message) => message.formatted ?? message.message),
]).transform((text) => text === undefined || text === '' ? undefined : text)

const sentryTagsSchema = z.union([
	z.array(z.tuple([z.unknown(), z.unknown()]).nullable().catch(null)).transform((pairs) =>
		pairs.flatMap((pair) => pair === null || pair[0] === null || pair[0] === undefined ? [] : [{ key: String(pair[0]), value: String(pair[1]) }])
	),
	z.record(z.unknown()).transform((tags) =>
		Object.entries(tags).flatMap(([key, value]) => value === null || value === undefined ? [] : [{ key, value: String(value) }])
	),
]).catch([]).transform((tags) => tags.filter((tag) => tag.key !== '__proto__'))

const sentryBreadcrumbListSchema = z.array(sentryBreadcrumbSchema.nullable().catch(null))
	.transform((breadcrumbs) => breadcrumbs.filter((breadcrumb) => breadcrumb !== null))

/** One Sentry event as both ingest and event detail read it; every field is optional and a malformed one reads as absent. */
export const sentryEventSchema = z.object({
	event_id: optionalText,
	level: optionalText,
	release: optionalText,
	environment: optionalText,
	platform: optionalText,
	server_name: optionalText,
	exception: sentryEventExceptionSchema.optional().catch(undefined),
	message: sentryMessageSchema.optional().catch(undefined),
	tags: sentryTagsSchema,
	fingerprint: z.array(z.unknown()).transform((parts) => parts.filter((part) => typeof part === 'string')).optional().catch(undefined),
	request: sentryRequestSchema.optional().catch(undefined),
	user: sentryUserSchema.optional().catch(undefined),
	context: z.object({ url: optionalText, user: sentryUserSchema.optional().catch(undefined) }).optional().catch(undefined),
	breadcrumbs: z.union([sentryBreadcrumbListSchema, z.object({ values: sentryBreadcrumbListSchema }).transform((value) => value.values)]).catch([]),
	contexts: z.object({
		runtime: sentryRuntimeSchema.optional().catch(undefined),
		os: sentryRuntimeSchema.optional().catch(undefined),
		browser: sentryRuntimeSchema.optional().catch(undefined),
		trace: z.object({ trace_id: optionalText }).optional().catch(undefined),
	}).optional().catch(undefined),
})

export type SentryEvent = z.infer<typeof sentryEventSchema>
export type SentryException = z.infer<typeof sentryExceptionSchema>
export type SentryRuntime = z.infer<typeof sentryRuntimeSchema>
