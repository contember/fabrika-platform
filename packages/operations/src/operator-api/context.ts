import type { AuthContext, ListPrincipalsFailure, PrincipalList } from '@fabrika/auth'
import type { BlobStore } from '@fabrika/platform'
import type { HealthRepository } from '../health-repository.js'
import type { OperationsRepositories } from '../repositories.js'
import { OperatorRequestError } from './errors.js'

export interface OperationsPrincipalDirectory {
	listPrincipals(request: Request): Promise<PrincipalList | ListPrincipalsFailure>
}

export interface OperationsOperatorOptions {
	repositories: OperationsRepositories
	health: HealthRepository
	payloads: BlobStore
	auth: AuthContext
	principals: OperationsPrincipalDirectory
	now?: () => number
}

/**
 * The people a caller may pick from, as IAM lists them to that caller's own token. IAM lists people only to a native
 * token, so a delegated (OAuth) caller is refused here with a 403 that says so, not with IAM's `invalid_token`.
 */
export async function listPeople(request: Request, options: OperationsOperatorOptions): Promise<PrincipalList> {
	if (options.auth.oauth !== undefined) throw new OperatorRequestError(403, 'a delegated token cannot list people; use the console')
	const result = await options.principals.listPrincipals(request)
	if (!result.ok) throw new OperatorRequestError(result.status, result.reason)
	return result
}
