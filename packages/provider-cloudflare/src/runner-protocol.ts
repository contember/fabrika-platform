import { contractArtifactSchema } from '@fabrika/app/contract'
import { type ContractArtifact, contractDigest } from '@fabrika/auth-core'
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

/**
 * The access Control approved for a run (ADR-0050): the contract it read at the commit. The proxy table and
 * `FABRIKA_CONTRACT_DIGEST` follow this, never the checkout.
 */
export interface RunnerApprovedAccess {
	readonly kind: 'contract'
	readonly contract: ContractArtifact
	readonly contractDigest: string
}

export const runnerApprovedAccessSchema = z.object({ kind: z.literal('contract'), contract: z.unknown(), contractDigest: z.string() }).strict()
	.transform((access, context): RunnerApprovedAccess => {
		const contract = contractArtifactSchema.safeParse(access.contract)
		if (!contract.success || contractDigest(contract.data) !== access.contractDigest) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: 'not a contract artifact its digest describes' })
			return z.NEVER
		}
		return { kind: 'contract', contract: contract.data, contractDigest: access.contractDigest }
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
