import { type BuilderConnectionReceiptDto, builderConnectionReceiptSchema } from '@fabrika/control-contract'
import { z } from 'zod'
import { parseBuilderOrigin, parseBuilderPreviewUrl } from './urls'

export { parseBuilderOrigin, parseBuilderPreviewUrl } from './urls'

export interface BuilderProjectConnection {
	controlOrigin: string
	iamIssuer: string
	receipt: BuilderConnectionReceiptDto
}

export interface BuilderProjectConfig {
	profile: string
	sessionId: string
	createdAt: string
	connection?: BuilderProjectConnection
	previewUrl?: string
}

export type BuilderPairingState =
	// Only the browser approval proof belongs in this URL's fragment; redemption credentials stay daemon-local.
	| { status: 'pending'; authorizationUrl: string; expiresAt: number }
	| { status: 'approved' }
	| { status: 'failed'; message: string }
	| { status: 'expired' }
	| { status: 'cancelled' }
	| { status: 'recovery_required'; message: string }
	| { status: 'connected' }

export interface BuilderDeploymentState {
	status: 'preparing' | 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
	runId: string | null
	commitSha: string | null
	message: string | null
	appUrl: string | null
	consoleUrl: string | null
}

export interface BuilderPlatformStatus {
	sessionId: string
	projectRoot: string
	connection: BuilderProjectConnection | null
	credential: { available: boolean; expiresAt: number | null }
	pairing: BuilderPairingState | null
	previewUrl: string | null
	deployment: BuilderDeploymentState | null
}

export interface RegisterProjectInput {
	projectRoot: string
}

export interface ConnectProjectInput {
	controlOrigin: string
}

export interface PreviewProjectInput {
	url: string | null
}

export interface BuilderErrorResponse {
	error: { code: string; message: string }
}

// These legacy daemon projections deliberately recover malformed optional fields.
const wireNumberSchema = z.union([z.number(), z.nan()])
const optionalTextSchema = z.string().optional().catch(undefined)
const phaseIdSchema = z.enum(['intake', 'vision', 'flows', 'tech', 'design', 'skeletons', 'issues', 'build'])
export const phaseStateSchema = z.object({
	current: phaseIdSchema,
	index: wireNumberSchema,
	completed: z.array(phaseIdSchema),
	reads: z.array(z.string()),
	produces: z.array(z.string()),
	gate: z.boolean(),
	satisfied: z.boolean(),
})
export const uiPhaseStateSchema = phaseStateSchema.extend({ gateName: z.string().nullable().optional().catch(undefined) })
	.transform(({ gateName, ...state }) => ({ ...state, ...(gateName === undefined ? {} : { gateName }) }))
export const healthInfoSchema = z.object({
	ok: z.literal(true),
	version: optionalTextSchema,
	pid: wireNumberSchema.optional().catch(undefined),
	dataDir: optionalTextSchema,
	sessionsDir: z.string(),
	sessions: z.union([wireNumberSchema, z.array(z.string())]).optional().catch(undefined),
}).transform(({ ok, version, pid, dataDir, sessionsDir, sessions }) => ({
	ok,
	...(version === undefined ? {} : { version }),
	...(pid === undefined ? {} : { pid }),
	...(dataDir === undefined ? {} : { dataDir }),
	sessionsDir,
	...(sessions === undefined ? {} : { sessions }),
}))
export const uiHealthSchema = z.object({
	ok: z.literal(true),
	version: optionalTextSchema,
	sessions: z.array(z.string()).optional().catch(undefined),
})
	.transform(({ ok, version, sessions }) => ({ ok, ...(version === undefined ? {} : { version }), ...(sessions === undefined ? {} : { sessions }) }))
export const activeDaemonSchema = z.object({ ok: z.literal(true), sessionsDir: z.string() })
export const builderPlatformErrorSchema = z.object({ error: z.object({ code: z.literal('builder_platform'), message: z.string().max(1000) }) })
export const planResultSchema = z.object({
	ok: z.boolean(),
	browserUrl: optionalTextSchema,
	revision: wireNumberSchema.optional().catch(undefined),
	isNew: z.boolean().optional().catch(undefined),
	canvasFiles: z.array(z.string()).optional().catch(undefined),
	gate: optionalTextSchema,
	error: optionalTextSchema,
	errors: z.record(z.string()).optional().catch(undefined),
}).transform(({ ok, browserUrl, revision, isNew, canvasFiles, gate, error, errors }) => ({
	ok,
	...(browserUrl === undefined ? {} : { browserUrl }),
	...(revision === undefined ? {} : { revision }),
	...(isNew === undefined ? {} : { isNew }),
	...(canvasFiles === undefined ? {} : { canvasFiles }),
	...(gate === undefined ? {} : { gate }),
	...(error === undefined ? {} : { error }),
	...(errors === undefined ? {} : { errors }),
}))
export const buildEventSchema = z.object({
	status: z.enum(['queued', 'running', 'passed', 'failed', 'blocked', 'info']),
	issue: optionalTextSchema,
	message: optionalTextSchema,
	at: optionalTextSchema,
	data: z.record(z.unknown()).optional().catch(undefined),
}).transform(({ status, issue, message, at, data }) => ({
	status,
	...(issue === undefined ? {} : { issue }),
	...(message === undefined ? {} : { message }),
	...(at === undefined ? {} : { at }),
	...(data === undefined ? {} : { data }),
}))
export const planInputSchema = z.object({
	view: optionalTextSchema,
	directory: optionalTextSchema,
	projectRoot: optionalTextSchema,
	gate: optionalTextSchema,
	label: optionalTextSchema,
	response: optionalTextSchema,
})
export const feedbackTextSchema = z.object({ feedback: z.string().catch('') })
export const consumedFeedbackSchema = feedbackTextSchema.extend({ found: z.literal(true) })
export const submitFeedbackSchema = feedbackTextSchema.extend({ type: z.literal('submit') })
export const feedbackRevisionSchema = z.object({
	revision: wireNumberSchema,
	hasFeedback: z.unknown().transform(value => value === true),
	feedbackConsumed: z.unknown().transform(value => value === true),
})
export const feedbackMetaSchema = z.object({
	revisions: z.array(feedbackRevisionSchema.nullable().catch(null)).transform(items => items.filter(item => item !== null)),
})
export const canvasFileSchema = z.union([
	z.string().transform(filename => ({ filename })),
	z.object({
		filename: z.string(),
		label: optionalTextSchema,
		diffStats: z.object({ added: wireNumberSchema, removed: wireNumberSchema }).optional().catch(undefined),
	}).transform(({ filename, label, diffStats }) => ({
		filename,
		...(label === undefined ? {} : { label }),
		...(diffStats === undefined ? {} : { diffStats }),
	})),
]).refine(value => value.filename.length > 0)
export const canvasFilesSchema = z.array(canvasFileSchema.nullable().catch(null))
	.transform(items => items.filter(item => item !== null)).catch([])
const canvasScopeSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('directory') }),
	z.object({ kind: z.literal('view'), filename: z.string() }),
])
export const revisionMetaSchema = feedbackRevisionSchema.extend({
	label: z.string().nullable().catch(null),
	canvasFiles: canvasFilesSchema,
	createdAt: optionalTextSchema,
	canvasScope: canvasScopeSchema.optional().catch(undefined),
}).transform(({ createdAt, canvasScope, ...revision }) => ({
	...revision,
	...(createdAt === undefined ? {} : { createdAt }),
	...(canvasScope === undefined ? {} : { canvasScope }),
})).refine(value => value.revision > 0)
export const sessionMetaSchema = z.object({
	projectRoot: optionalTextSchema,
	label: optionalTextSchema,
	gate: z.string().nullable().catch(null),
	currentRevision: wireNumberSchema.catch(0),
	canvasFiles: canvasFilesSchema,
	revisions: z.array(revisionMetaSchema.nullable().catch(null)).transform(items => items.filter(item => item !== null)).catch([]),
}).transform(({ projectRoot, label, ...meta }) => ({
	...meta,
	...(projectRoot === undefined ? {} : { projectRoot }),
	...(label === undefined ? {} : { label }),
}))
export const sessionSummarySchema = z.object({ id: z.string(), label: optionalTextSchema })
	.transform(({ id, label }) => ({ id, ...(label === undefined ? {} : { label }) }))
export const sessionsSchema = z.array(sessionSummarySchema.nullable().catch(null)).transform(items => items.filter(item => item !== null)).catch([])
export const skeletonSchema = z.object({
	file: z.string(),
	name: z.string(),
	seeds: z.array(z.string()),
	roles: z.array(z.string()),
	steps: wireNumberSchema,
	invariants: wireNumberSchema,
	pending: wireNumberSchema,
	url: optionalTextSchema,
	feature: optionalTextSchema,
}).transform(({ url, feature, ...skeleton }) => ({
	...skeleton,
	...(url === undefined ? {} : { url }),
	...(feature === undefined ? {} : { feature }),
}))
export const skeletonsSchema = z.object({
	skeletons: z.array(skeletonSchema.nullable().catch(null)).transform(items => items.filter(item => item !== null)),
})
export const artifactResponseSchema = z.object({ content: z.string() })
export const responsesEnvelopeSchema = z.object({ responses: z.unknown() })
export const wsMessageSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('plan-updated'),
		currentRevision: wireNumberSchema,
		canvasFiles: z.array(z.unknown()).transform(value => canvasFilesSchema.parse(value)).optional().catch(undefined),
		gate: z.string().nullable().optional().catch(undefined),
	}),
	z.object({ type: z.literal('revision-updated'), currentRevision: wireNumberSchema }),
	z.object({ type: z.literal('watcher-status'), watching: z.boolean() }),
	z.object({ type: z.literal('phase-updated') }),
	z.object({ type: z.literal('submit-ack'), revision: wireNumberSchema }),
]).transform(message => {
	if (message.type !== 'plan-updated') return message
	const { canvasFiles, gate, ...rest } = message
	return { ...rest, ...(canvasFiles === undefined ? {} : { canvasFiles }), ...(gate === undefined ? {} : { gate }) }
})

const nonemptyStringSchema = z.string().refine(value => value.trim().length > 0)
const timestampSchema = z.number().finite().nonnegative()
const originSchema = z.string().transform((value, ctx) => {
	try {
		return parseBuilderOrigin(value)
	} catch {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid builder origin' })
		return z.NEVER
	}
})
const previewUrlSchema = z.string().transform((value, ctx) => {
	try {
		return parseBuilderPreviewUrl(value)
	} catch {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid preview URL' })
		return z.NEVER
	}
})
export const builderProjectConnectionSchema = z.object({
	controlOrigin: originSchema,
	iamIssuer: originSchema,
	receipt: builderConnectionReceiptSchema,
}).strict()
export const builderProjectConfigSchema = z.object({
	profile: nonemptyStringSchema,
	sessionId: nonemptyStringSchema,
	createdAt: nonemptyStringSchema.refine(value => Number.isFinite(Date.parse(value))),
	connection: builderProjectConnectionSchema.optional(),
	previewUrl: previewUrlSchema.optional(),
}).strict().superRefine((value, ctx) => {
	for (const key of ['connection', 'previewUrl']) {
		if (Object.hasOwn(value, key) && Reflect.get(value, key) === undefined) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Present field must not be undefined' })
		}
	}
})
export const builderPairingStateSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('pending'),
		authorizationUrl: previewUrlSchema.refine(value => {
			try {
				parseBuilderOrigin(new URL(value).origin)
				return true
			} catch {
				return false
			}
		}),
		expiresAt: timestampSchema,
	}).strict(),
	z.object({ status: z.literal('approved') }).strict(),
	z.object({ status: z.literal('failed'), message: nonemptyStringSchema }).strict(),
	z.object({ status: z.literal('expired') }).strict(),
	z.object({ status: z.literal('cancelled') }).strict(),
	z.object({ status: z.literal('recovery_required'), message: nonemptyStringSchema }).strict(),
	z.object({ status: z.literal('connected') }).strict(),
])
export const builderDeploymentStateSchema = z.object({
	status: z.enum(['preparing', 'pending', 'running', 'succeeded', 'failed', 'cancelled']),
	runId: nonemptyStringSchema.nullable(),
	commitSha: nonemptyStringSchema.nullable(),
	message: nonemptyStringSchema.nullable(),
	appUrl: previewUrlSchema.nullable(),
	consoleUrl: previewUrlSchema.nullable(),
}).strict()
export const builderPlatformStatusSchema = z.object({
	sessionId: nonemptyStringSchema,
	projectRoot: nonemptyStringSchema,
	connection: builderProjectConnectionSchema.nullable(),
	credential: z.object({ available: z.boolean(), expiresAt: timestampSchema.nullable() }).strict(),
	pairing: builderPairingStateSchema.nullable(),
	previewUrl: previewUrlSchema.nullable(),
	deployment: builderDeploymentStateSchema.nullable(),
}).strict()
export const registerProjectInputSchema = z.object({ projectRoot: nonemptyStringSchema }).strict()
export const connectProjectInputSchema = z.object({ controlOrigin: originSchema }).strict()
export const previewProjectInputSchema = z.object({ url: previewUrlSchema.nullable() }).strict()

export function parseBuilderProjectConnection(value: unknown): BuilderProjectConnection {
	const result = builderProjectConnectionSchema.safeParse(value)
	if (!result.success) throw new Error('Invalid project connection')
	return result.data
}

export function parseBuilderProjectConfig(value: unknown): BuilderProjectConfig {
	const result = builderProjectConfigSchema.safeParse(value)
	if (!result.success) throw new Error('Invalid project config')
	return result.data
}

export function parseBuilderPairingState(value: unknown): BuilderPairingState {
	const result = builderPairingStateSchema.safeParse(value)
	if (!result.success) throw new Error('Invalid pairing state')
	return result.data
}

export function parseBuilderDeploymentState(value: unknown): BuilderDeploymentState {
	const result = builderDeploymentStateSchema.safeParse(value)
	if (!result.success) throw new Error('Invalid deployment state')
	return result.data
}

export function parseBuilderPlatformStatus(value: unknown): BuilderPlatformStatus {
	const result = builderPlatformStatusSchema.safeParse(value)
	if (!result.success) throw new Error('Invalid platform status')
	return result.data
}

export function parseRegisterProjectInput(value: unknown): RegisterProjectInput {
	const result = registerProjectInputSchema.safeParse(value)
	if (!result.success) throw new Error('Invalid register input')
	return result.data
}

export function parseConnectProjectInput(value: unknown): ConnectProjectInput {
	const result = connectProjectInputSchema.safeParse(value)
	if (!result.success) throw new Error('Invalid connect input')
	return result.data
}

export function parsePreviewProjectInput(value: unknown): PreviewProjectInput {
	const result = previewProjectInputSchema.safeParse(value)
	if (!result.success) throw new Error('Invalid preview input')
	return result.data
}

export function builderProjectPath(id: string, suffix: 'register' | 'platform' | 'connect' | 'disconnect' | 'deploy' | 'preview'): string {
	const result = nonemptyStringSchema.safeParse(id)
	if (!result.success) throw new Error('project id must be a non-empty string')
	return `/api/project/${encodeURIComponent(result.data)}/${suffix}`
}
