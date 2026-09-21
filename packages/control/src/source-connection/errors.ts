/**
 * A short, BOUNDED reason a source call failed — the port's own code and HTTP status, and nothing else.
 *
 * The cause used to be discarded here, so an operator who could not finish a connection saw a bare
 * status and no reason, and the control plane logged nothing either. Finding that a redeployed source
 * container was refusing `verifyInstallations` took hours of reading logs that did not record it.
 *
 * Deliberately STRUCTURAL rather than `error.message`: a port implementation's message is not ours to
 * trust with a browser, and a credential must never reach one (root CLAUDE.md). A code and a status
 * cannot carry a token; a message can.
 */
const sourceFailureReason = (error: unknown): string | undefined => {
	if (typeof error !== 'object' || error === null) return undefined
	const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
	const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined
	if (code === undefined && status === undefined) return undefined
	return [code, status === undefined ? undefined : `status ${status}`].filter((part) => part !== undefined).join(', ')
}

/** Same, for a resumed setup: the phase lamp says WHERE it stopped, this says why. */
export const repairFailed = (error: unknown): SourceConnectionWorkflowError => {
	const reason = sourceFailureReason(error)
	return new SourceConnectionWorkflowError(502, reason === undefined ? 'the setup could not be resumed' : `the setup could not be resumed: ${reason}`)
}

/** `502` with the port's reason attached when it gave one, so the console names something actionable. */
export const sourceUnavailable = (error: unknown): SourceConnectionWorkflowError => {
	const reason = sourceFailureReason(error)
	return new SourceConnectionWorkflowError(502, reason === undefined ? 'the source service did not answer' : `the source service refused: ${reason}`)
}

export const reconcileUnavailable = (stage: 'inspect' | 'configure', error: unknown): SourceConnectionWorkflowError => {
	const reason = sourceFailureReason(error)
	const action = stage === 'inspect' ? 'inspect the durable credential' : 'configure the GitHub webhook'
	return new SourceConnectionWorkflowError(
		503,
		reason === undefined ? `the source service could not ${action}` : `the source service could not ${action}: ${reason}`,
	)
}

export class SourceConnectionWorkflowError extends Error {
	readonly type = 'source_connection'

	constructor(readonly httpStatus: number, message = 'source connection request failed') {
		super(message)
		this.name = 'SourceConnectionWorkflowError'
	}
}
