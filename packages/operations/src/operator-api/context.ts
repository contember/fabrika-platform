import type { AuthContext, ListPrincipalsFailure, PrincipalList } from '@fabrika/auth'
import type { BlobStore } from '@fabrika/platform'
import type { HealthRepository } from '../health-repository.js'
import type { OperationsRepositories } from '../repositories.js'

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
