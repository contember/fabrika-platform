import { annotationAuthorSchema, annotationSchema } from '@fabrika/annotations/schemas'
import { z } from 'zod'

const diffStatsSchema = z.object({ added: z.number(), removed: z.number() }).passthrough()
const revisionFields = {
	revision: z.number().int(),
	label: z.string().optional(),
	createdAt: z.string(),
	hasFeedback: z.boolean(),
	feedbackConsumed: z.boolean(),
	response: z.string().optional(),
}
const revisionSchema = z.object({
	...revisionFields,
	canvasFiles: z.array(z.object({ filename: z.string(), diffStats: diffStatsSchema.optional() }).passthrough()),
	canvasScope: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('view'), filename: z.string() }).passthrough(),
		z.object({ kind: z.literal('directory') }).passthrough(),
	]).optional(),
}).passthrough()
const legacyRevisionSchema = z.object({
	...revisionFields,
	canvasFiles: z.never().optional(),
	sourceFile: z.string().optional(),
	diffStats: diffStatsSchema.optional(),
}).passthrough()
const shareSchema = z.object({
	shareId: z.string(),
	url: z.string(),
	revision: z.number().int(),
	createdAt: z.string(),
	ownerToken: z.string().optional(),
	expiresAt: z.string().optional(),
	lastFeedbackAt: z.string().optional(),
	encryptionKey: z.string().optional(),
}).passthrough()
const metadataFields = {
	projectRoot: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
}
export const savedSessionMetadataSchema = z.object({
	...metadataFields,
	currentRevision: z.number().int(),
	revisions: z.array(z.union([revisionSchema, legacyRevisionSchema])),
	shares: z.array(shareSchema).optional(),
}).passthrough().transform(meta => ({
	migrated: meta.revisions.some(revision => revision.canvasFiles === undefined),
	meta: {
		...meta,
		revisions: meta.revisions.map(revision => {
			if (revision.canvasFiles !== undefined) return revision
			const { sourceFile, diffStats, canvasFiles: _canvasFiles, ...fields } = revision
			return { ...fields, canvasFiles: [{ filename: sourceFile || 'plan.jsx', diffStats }] }
		}),
	},
}))

export const remoteFeedbackEntrySchema = z.object({
	id: z.string(),
	shareId: z.string(),
	revision: z.number().int(),
	submittedAt: z.string(),
	author: annotationAuthorSchema,
	annotations: z.array(annotationSchema.omit({ images: true, source: true, author: true }).optional().catch(undefined))
		.transform(annotations => annotations.filter(annotation => annotation !== undefined)),
	generalNote: z.string().optional(),
}).passthrough()

export const remoteFeedbackSchema = z.array(remoteFeedbackEntrySchema.optional().catch(undefined))
	.transform(entries => entries.filter(entry => entry !== undefined)).catch([])
