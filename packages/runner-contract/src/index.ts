export type { RunLogLine } from '@fabrika/control-contract'

/** The lifecycle a run moves through inside the transport container. */
export type RunnerState = 'pending' | 'cloning' | 'installing' | 'deploying' | 'succeeded' | 'failed'

/** The IAM schema the executor compiled from the checkout, as JSON text; the control plane parses, validates and applies it with its own key. */
export interface RunnerIamReconcile {
	readonly app: string
	readonly schemaJson: string
}

/** What the executor leaves at `$FABRIKA_RUNNER_OUTCOME_FILE` for the runner to fold into its terminal status. */
export interface RunnerOutcomeFile {
	readonly iamReconcile?: RunnerIamReconcile
}

export const RUNNER_OUTCOME_FILE_ENV = 'FABRIKA_RUNNER_OUTCOME_FILE'

/** The terminal and in-progress status polled from the container. */
export interface RunnerStatus {
	readonly runId: string
	readonly state: RunnerState
	readonly exitCode?: number
	readonly error?: string
	readonly artifactState?: 'complete' | 'incomplete' | 'not_applicable'
	readonly iamReconcile?: RunnerIamReconcile
	readonly startedAt: number
	readonly finishedAt?: number
}

export const RUNNER_PORT = 8080
export const RUNNER_RUN_PATH = '/run'
export const RUNNER_LOGS_PATH = '/logs'
export const RUNNER_STATUS_PATH = '/status'
export const RUNNER_HEALTH_PATH = '/health'
