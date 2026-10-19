import { annotationAuthorSchema, annotationSchema } from '@fabrika/annotations/schemas'
import { z } from 'zod'

export const shareEntrySchema = z.object({
	shareId: z.string(),
	url: z.string(),
	revision: z.number(),
	createdAt: z.string(),
	ownerToken: z.string().optional(),
	expiresAt: z.string().optional(),
	lastFeedbackAt: z.string().optional(),
	/** Present iff the share is end-to-end encrypted; the URL itself
	 *  carries the key in the `#k=...` fragment. */
	encryptionKey: z.string().optional(),
})

export type ShareEntry = z.infer<typeof shareEntrySchema>

const revisionInfoSchema = z.object({
	revision: z.number(),
	label: z.string().optional(),
	canvasFiles: z.array(z.object({
		filename: z.string(),
		diffStats: z.object({ added: z.number(), removed: z.number() }).optional(),
	})),
	createdAt: z.string(),
	hasFeedback: z.boolean(),
	feedbackConsumed: z.boolean(),
	response: z.string().optional(),
}).passthrough()

/** Served by the daemon for a session and by the share worker for a share, which leaves `projectRoot` out. */
export const sessionMetaSchema = z.object({
	encryption: z.object({ alg: z.literal('AES-GCM'), v: z.literal(1) }).optional(),
	origin: z.object({
		sessionId: z.string().optional(),
		label: z.string().optional(),
		revision: z.number().optional(),
		createdAt: z.string().optional(),
	}).optional(),
	currentRevision: z.number().optional(),
	revisions: z.array(revisionInfoSchema).optional(),
	canvasFiles: z.array(z.string()).optional(),
	projectRoot: z.string().optional(),
	shares: z.array(shareEntrySchema).optional(),
	shareEnabled: z.boolean().optional(),
}).passthrough()

export type SessionMeta = z.infer<typeof sessionMetaSchema>

export const treeResponseSchema = z.object({
	entries: z.array(z.object({ name: z.string(), type: z.enum(['file', 'dir']) })),
})

/** Mirrors the daemon's RemoteFeedbackEntry. */
export const remoteFeedbackEntrySchema = z.object({
	id: z.string(),
	shareId: z.string(),
	revision: z.number(),
	submittedAt: z.string(),
	author: annotationAuthorSchema,
	annotations: z.array(annotationSchema.omit({ source: true, author: true })),
	generalNote: z.string().optional(),
})

export type RemoteFeedbackEntry = z.infer<typeof remoteFeedbackEntrySchema>

export const remoteFeedbackResponseSchema = z.object({ entries: z.array(remoteFeedbackEntrySchema) })

export const shareCreatedResponseSchema = z.union([
	z.object({ ok: z.literal(true), share: shareEntrySchema }),
	z.object({ ok: z.literal(false).optional(), error: z.string().optional() }),
])

export const shareRevokedResponseSchema = z.union([
	z.object({ ok: z.literal(true) }),
	z.object({ ok: z.literal(false).optional(), error: z.string().optional() }),
])
