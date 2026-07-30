export type { RunLogLine } from '@fabrika/control-contract'

/** The lifecycle a run moves through inside the transport container. */
export type RunnerState = 'pending' | 'cloning' | 'installing' | 'deploying' | 'succeeded' | 'failed'

/** The terminal and in-progress status polled from the container. */
export interface RunnerStatus {
	readonly runId: string
	readonly state: RunnerState
	readonly exitCode?: number
	readonly error?: string
	readonly startedAt: number
	readonly finishedAt?: number
}

export const RUNNER_PORT = 8080
export const RUNNER_RUN_PATH = '/run'
export const RUNNER_LOGS_PATH = '/logs'
export const RUNNER_STATUS_PATH = '/status'
export const RUNNER_HEALTH_PATH = '/health'
