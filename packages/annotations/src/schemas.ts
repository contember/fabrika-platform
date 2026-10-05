import { z } from 'zod'

export const annotationContextSchema = z.object({
	before: z.string(),
	after: z.string(),
	hierarchy: z.array(z.string()),
	lineStart: z.number().optional(),
	lineEnd: z.number().optional(),
}).passthrough()

export const annotationAuthorSchema = z.object({ id: z.string(), name: z.string() }).passthrough()
export const annotationAttachmentSchema = z.object({ url: z.string(), mime: z.string().optional() }).passthrough()

export const annotationSchema = z.object({
	id: z.string(),
	snippet: z.string(),
	note: z.string(),
	createdAt: z.string(),
	filePath: z.string().optional(),
	canvasFile: z.string().optional(),
	context: annotationContextSchema.optional(),
	images: z.array(z.string()).optional(),
	attachments: z.array(annotationAttachmentSchema).optional(),
	source: z.enum(['local', 'remote']).optional(),
	author: annotationAuthorSchema.optional(),
}).passthrough()

// A damaged entry must not discard the other annotations in a saved draft.
export const recoveredAnnotationsSchema = z.array(annotationSchema.optional().catch(undefined)).transform(entries =>
	entries.filter(entry => entry !== undefined)
).catch([])

export const annotationStateSchema = z.object({
	annotations: recoveredAnnotationsSchema,
	generalNote: z.string().catch(''),
}).passthrough()

export const localUploadResponseSchema = z.object({ path: z.string() })
export const sharedUploadResponseSchema = z.object({ url: z.string() })
