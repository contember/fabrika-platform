import { contractArtifactSchema } from '@fabrika/app/contract'
import { type ContractArtifact, isDigest, parseApplicationObjects } from '@fabrika/auth-core'
import { FRAMEWORK_RELEASE_PATTERN } from '@fabrika/provider-contract'
import { z } from 'zod'

export const runnerStateSchema = z.enum(['pending', 'cloning', 'installing', 'deploying', 'succeeded', 'failed'])

/** The lifecycle a run moves through inside the transport container. */
export type RunnerState = z.infer<typeof runnerStateSchema>

/** The IAM schema the executor compiled from the checkout, as JSON text; the control plane parses, validates and applies it with its own key. */
export const runnerIamReconcileSchema = z.object({ app: z.string(), schemaJson: z.string() })

export type RunnerIamReconcile = z.infer<typeof runnerIamReconcileSchema>

/** What the executor leaves at `$FABRIKA_RUNNER_OUTCOME_FILE` for the runner to fold into its terminal status. */
export interface RunnerOutcomeFile {
	readonly iamReconcile?: RunnerIamReconcile
}

export const RUNNER_OUTCOME_FILE_ENV = 'FABRIKA_RUNNER_OUTCOME_FILE'

/** The executor's copy of `CloudflareRunnerJob.installationApps`: a JSON array of `<app>@<env>`. */
export const INSTALLATION_APPS_ENV = 'FABRIKA_INSTALLATION_APPS'

/** The executor's copy of `CloudflareRunnerJob.crossOrigins`: a JSON array of the environment's exact origins. */
export const CROSS_ORIGINS_ENV = 'FABRIKA_CROSS_ORIGINS'

/** The executor's copy of `CloudflareRunnerJob.operationsOrigin`: the origin of the environment's Operations ingest. */
export const OPERATIONS_ORIGIN_ENV = 'FABRIKA_OPERATIONS_ORIGIN'

/** The executor's copy of `CloudflareRunnerJob.applicationObjects`: JSON `{ object, objects }`, the pointer Control records. */
export const APPLICATION_OBJECTS_ENV = 'FABRIKA_RUNNER_APPLICATION_OBJECTS'

/**
 * The serving object and the listed objects as the job and the executor carry them: the shape `parseApplicationObjects`
 * accepts, so a pointer the application would refuse never reaches a deploy.
 */
export const applicationObjectsSchema = z.object({ object: z.string(), objects: z.array(z.string()) }).strict().transform((value, ctx) => {
	const parsed = parseApplicationObjects(value.object, value.objects.join(','))
	if (parsed === null) {
		ctx.addIssue({ code: 'custom', message: 'not a valid serving object and object list' })
		return z.NEVER
	}
	return parsed
})

/**
 * The access Control approved for a run (ADR-0050): the contract it read at the commit, in this release's model, and
 * the digest the application's own framework release computes for it. The proxy table and `FABRIKA_CONTRACT_DIGEST`
 * follow this, never the checkout. The digest is not `contractDigest(contract)` when Control upcast the contract from
 * an older release's artifact (ADR-0062), so the executor cannot recompute it and takes Control's.
 */
export interface RunnerApprovedAccess {
	readonly kind: 'contract'
	readonly contract: ContractArtifact
	readonly contractDigest: string
	/**
	 * The framework release the application pins (`applicationRelease`), which every release gate of the deployer reads:
	 * the Durable Object from 0.9, the stateless Worker before it. An older Control sends its reader's
	 * release here, a newer patch of the same minor. Absent from a Control older than the runner, which deploys the
	 * older shape.
	 */
	readonly framework?: string
	/** The database the application chose in its config: Postgres through Hyperdrive. Absent = the object's SQLite (ADR-0065). */
	readonly database?: 'postgres'
}

export const runnerApprovedAccessSchema = z.object({
	kind: z.literal('contract'),
	contract: z.unknown(),
	contractDigest: z.string().refine(isDigest),
	framework: z.string().regex(FRAMEWORK_RELEASE_PATTERN).optional(),
	database: z.literal('postgres').optional(),
})
	.strict()
	.transform((access, context): RunnerApprovedAccess => {
		const contract = contractArtifactSchema.safeParse(access.contract)
		if (!contract.success) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: 'not a contract artifact' })
			return z.NEVER
		}
		return {
			kind: 'contract',
			contract: contract.data,
			contractDigest: access.contractDigest,
			...(access.framework === undefined ? {} : { framework: access.framework }),
			...(access.database === undefined ? {} : { database: access.database }),
		}
	})

/** Where the runner leaves the job's `RunnerApprovedAccess` as JSON for the executor — beside the checkout, never inside it. */
export const APPROVED_ACCESS_FILE_ENV = 'FABRIKA_APPROVED_ACCESS_FILE'

/** The terminal and in-progress status polled from the container, and persisted by the runner Worker once terminal. */
export const runnerStatusSchema = z.object({
	runId: z.string(),
	state: runnerStateSchema,
	exitCode: z.number().finite().optional(),
	error: z.string().optional(),
	artifactState: z.enum(['complete', 'incomplete', 'not_applicable']).optional(),
	iamReconcile: runnerIamReconcileSchema.optional(),
	/** A preview: nothing was deployed and nothing may be applied from it. */
	dryRun: z.boolean().optional(),
	startedAt: z.number().finite(),
	finishedAt: z.number().finite().optional(),
})

export type RunnerStatus = z.infer<typeof runnerStatusSchema>

export const RUNNER_PORT = 8080
export const RUNNER_RUN_PATH = '/run'
export const RUNNER_LOGS_PATH = '/logs'
export const RUNNER_STATUS_PATH = '/status'
export const RUNNER_HEALTH_PATH = '/health'
