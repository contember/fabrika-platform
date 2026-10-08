import { SourceFailure } from '../source/failure'

/**
 * A short, BOUNDED reason a GitHub App call failed — its stable code, and nothing else.
 *
 * Deliberately STRUCTURAL rather than `error.message`: an upstream message is not ours to trust with a
 * browser, and a credential must never reach one (root CLAUDE.md). A code cannot carry a token.
 */
const sourceFailureReason = (error: unknown): string | undefined => error instanceof SourceFailure ? error.code : undefined

/** Same, for a resumed setup: the phase lamp says WHERE it stopped, this says why. */
export const repairFailed = (error: unknown): SourceConnectionWorkflowError => {
	const reason = sourceFailureReason(error)
	return new SourceConnectionWorkflowError(502, reason === undefined ? 'the setup could not be resumed' : `the setup could not be resumed: ${reason}`)
}

/** `502` with the port's reason attached when it gave one, so the console names something actionable. */
export const sourceUnavailable = (error: unknown): SourceConnectionWorkflowError => {
	const reason = sourceFailureReason(error)
	return new SourceConnectionWorkflowError(502, reason === undefined ? 'the GitHub App request failed' : `the GitHub App request failed: ${reason}`)
}

export const reconcileUnavailable = (stage: 'verify' | 'configure', error: unknown): SourceConnectionWorkflowError => {
	const reason = sourceFailureReason(error)
	const action = stage === 'verify' ? 'verify the GitHub App' : 'configure the GitHub webhook'
	return new SourceConnectionWorkflowError(503, reason === undefined ? `could not ${action}` : `could not ${action}: ${reason}`)
}

export class SourceConnectionWorkflowError extends Error {
	readonly type = 'source_connection'

	constructor(readonly httpStatus: number, message = 'source connection request failed') {
		super(message)
		this.name = 'SourceConnectionWorkflowError'
	}
}
