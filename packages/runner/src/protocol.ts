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

/** One redacted output line streamed from the container. */
export interface LogLine {
	readonly ts: number
	readonly stream: 'stdout' | 'stderr' | 'meta'
	readonly text: string
}

export const RUNNER_PORT = 8080
export const RUNNER_HEALTH_PATH = '/health'
