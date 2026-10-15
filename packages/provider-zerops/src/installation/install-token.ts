import { ZeropsApiError } from '../index'
import type { InstallCollaborators } from './install-collaborators'

/** The platform's answer when an integration token without delegation asks to mint another one. */
const MINT_REFUSED_TO_INTEGRATION_TOKEN = 'notAllowedForIntegrationTokenWithoutDelegation'

/** How `/user/info` names an integration token. Reported by an operator, not measured here. */
const INTEGRATION_TOKEN_EMAIL = /^token-[^@]+@zerops\.io$/i

const PERSONAL_TOKEN_REQUIRED = 'FABRIKA_ZEROPS_ACCESS_TOKEN is a Zerops integration token (`/user/info` names it `token-…@zerops.io`), '
	+ 'and an integration token may not mint the one the control plane needs. Generate a personal access token in the Zerops GUI, '
	+ 'as a user who is OWNER on the client'

/**
 * Refuse an integration token before anything is created.
 *
 * The install mints an integration token at step 4, and an integration token is refused that mint. Without
 * this read the mistake costs a billed project and six imported services first.
 */
export const assertPersonalAccessToken = async ({ api, signal }: InstallCollaborators): Promise<void> => {
	const identity = await api.getUserInfo({ signal })
	if (INTEGRATION_TOKEN_EMAIL.test(identity.email)) {
		throw new Error(`${PERSONAL_TOKEN_REQUIRED}. Nothing was created`)
	}
}

/** Translate the mint's refusal of an integration token into the fix and the way back into this project. */
export const explainMintFailure = (failure: unknown, projectId: string): unknown => {
	if (!(failure instanceof ZeropsApiError) || failure.code !== MINT_REFUSED_TO_INTEGRATION_TOKEN) {
		return failure
	}
	return new Error(
		`${PERSONAL_TOKEN_REQUIRED}. No generated secret was placed yet: re-run the install with the personal token and `
			+ `--project-id=${projectId} instead of --create-project; it keeps the services already imported`,
		{ cause: failure },
	)
}
