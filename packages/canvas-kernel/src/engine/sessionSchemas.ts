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

/** What a submit says about each annotation it carried: enough for the host to open a thread on it later. */
export const submittedAnnotationSchema = z.object({
	id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
	snippet: z.string().max(20_000),
	note: z.string().max(20_000),
	canvasFile: z.string().max(500).optional(),
	filePath: z.string().max(4_000).optional(),
})
export type SubmittedAnnotation = z.infer<typeof submittedAnnotationSchema>

export const MAX_SUBMITTED_ANNOTATIONS = 500
export const submittedAnnotationsSchema = z.array(submittedAnnotationSchema).max(MAX_SUBMITTED_ANNOTATIONS)

// A submit is the user's feedback: an annotation the host cannot thread is left out, the feedback is still saved.
export const submittedAnnotationsFrameSchema = z.array(submittedAnnotationSchema.optional().catch(undefined))
	.transform(entries => entries.filter(entry => entry !== undefined).slice(0, MAX_SUBMITTED_ANNOTATIONS))
	.catch([])
