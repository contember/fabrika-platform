import { z } from 'zod'

export const operationsReleaseCoordinateSchema = z.object({
	appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
	environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
	serviceKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/).optional(),
}).transform(({ appId, environment, serviceKey }) => ({ appId, environment, ...(serviceKey === undefined ? {} : { serviceKey }) }))

export const operationsReleaseAvailabilitySchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('available'),
		name: z.string().max(512),
		commitSha: z.string().toLowerCase().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
	}),
	z.object({ kind: z.literal('unavailable'), reason: z.enum(['dry_run', 'missing_commit']) }),
])

export const operationsArtifactUploadCredentialSchema = z.object({
	verifier: z.string().regex(/^[0-9a-f]{64}$/),
	expiresAt: z.number().int().safe(),
})

export const operationsReleasePayloadSchema = z.object({
	runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
	coordinate: operationsReleaseCoordinateSchema,
	phase: z.enum(['started', 'provider_accepted', 'terminal']),
	providerRunId: z.string().max(256).nullable(),
	outcome: z.enum(['succeeded', 'failed']).nullable(),
	artifactState: z.enum(['pending', 'complete', 'incomplete', 'not_applicable']),
	release: operationsReleaseAvailabilitySchema,
	uploadCredential: operationsArtifactUploadCredentialSchema.optional(),
	observedAt: z.number().int().safe().nonnegative(),
}).superRefine((value, ctx) => {
	if (value.uploadCredential !== undefined && value.uploadCredential.expiresAt <= value.observedAt) {
		ctx.addIssue({ code: 'custom', path: ['uploadCredential'], message: 'invalid upload credential' })
	}
	if (value.release.kind === 'unavailable' && value.uploadCredential !== undefined) {
		ctx.addIssue({ code: 'custom', message: 'unavailable releases cannot accept artifacts' })
	}
	if (value.phase === 'terminal' && value.outcome === null) {
		ctx.addIssue({ code: 'custom', message: 'terminal release has no outcome' })
	}
	if (value.phase !== 'terminal' && value.outcome !== null) {
		ctx.addIssue({ code: 'custom', message: 'non-terminal release has an outcome' })
	}
}).transform(({ uploadCredential, observedAt, ...payload }) => ({
	...payload,
	...(uploadCredential === undefined ? {} : { uploadCredential }),
	observedAt,
}))

export const operationsSourceMapBuildUploadSchema = z.object({
	destination: z.object({
		url: z.string().url(),
		appId: z.string().min(1),
		environment: z.string().min(1),
		serviceKey: z.string().min(1),
		release: z.string().min(1),
		runId: z.string().min(1),
	}),
	assetRoots: z.array(z.object({ prefix: z.string().startsWith('/'), dir: z.string().min(1) })).max(64),
})

const releaseRequestHeaderSchema = z.object({ revision: z.number().int().safe().min(1) }).passthrough()

export const operationsReleaseRequestSchema = releaseRequestHeaderSchema.transform((value, ctx) => {
	const payload = operationsReleasePayloadSchema.safeParse(value)
	if (!payload.success) {
		for (const issue of payload.error.issues) ctx.addIssue(issue)
		return z.NEVER
	}
	return { revision: value.revision, ...payload.data }
})

/** Preserve the public decoder's error categories and first-failure precedence. */
export function operationsReleaseIssueMessage(issues: z.ZodIssue[]): string {
	if (
		issues.some((issue) => {
			const field = issue.path[0]
			return issue.code !== 'custom' && (field !== 'coordinate' && field !== 'release' && field !== 'uploadCredential'
				|| ((field === 'coordinate' || field === 'release') && issue.path.length === 1 && issue.code === 'invalid_type'))
		})
	) return 'invalid release request'
	if (issues.some((issue) => issue.path[0] === 'coordinate')) return 'invalid release coordinates'
	const release = issues.find((issue) => issue.path[0] === 'release')
	if (release !== undefined) {
		if (release.code === 'invalid_union_discriminator') return 'invalid release availability'
		return release.path[1] === 'reason' ? 'invalid unavailable release' : 'invalid available release'
	}
	if (issues.some((issue) => issue.path[0] === 'uploadCredential')) return 'invalid upload credential'
	return issues[0]?.message ?? 'invalid release request'
}
