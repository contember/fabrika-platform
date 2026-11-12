import { SourceFailure } from '../source/failure'

/**
 * A short, BOUNDED reason a GitHub App call failed — its stable code, and nothing else.
 *
 * Deliberately STRUCTURAL rather than `error.message`: an upstream message is not ours to trust with a
 * browser, and a credential must never reach one (root CLAUDE.md). A code cannot carry a token.
 */
const sourceFailureReason = (error: unknown): string | undefined => error instanceof SourceFailure ? error.code : undefined

/**
 * The answer when GitHub created the App on another owner than the setup asked for: the attempt has failed, and only the
 * operator can fix it, so the answer says how. `undefined` for any other failure. `owner` is the validated login the
 * setup asked for, never upstream text.
 */
export const appOwnerFailed = (owner: string, error: unknown): SourceConnectionWorkflowError | undefined => {
	const reason = sourceFailureReason(error)
	if (reason === 'app_owner_not_organization') {
		return new SourceConnectionWorkflowError(
			422,
			`GitHub created the App on a personal account, not in the organization ${owner}. Delete that App in your GitHub developer settings, check that you may create Apps in ${owner}, and connect again. If ${owner} is a personal account, connect it as a personal account.`,
		)
	}
	if (reason === 'app_owner_mismatch') {
		return new SourceConnectionWorkflowError(
			422,
			`GitHub created the App on another account, not on the personal account ${owner}. Delete that App in your GitHub developer settings, sign in to GitHub as ${owner}, and connect again.`,
		)
	}
	return undefined
}

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
