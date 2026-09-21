import type { SqlDatabase } from '@fabrika/platform'
import { PasswordRepository } from './password-db'
import { AppSchemaRepository } from './repositories/app-schema'
import { AuditRepository } from './repositories/audit'
import { CredentialRepository } from './repositories/credentials'
import { GrantRepository } from './repositories/grants'
import { HandoffRepository } from './repositories/handoff'
import { PrincipalRepository } from './repositories/principals'
import { SessionRepository } from './repositories/sessions'

export { type AppActionRow, AppSchemaRepository, type AppScopeRow, type RoleRow } from './repositories/app-schema'
export { type AuditEventInput, type AuditEventRow, AuditRepository, type AuthLogInput, type AuthLogRow } from './repositories/audit'
export { type CredentialGrantRow, CredentialRepository, type CredentialRow } from './repositories/credentials'
export { GrantRepository, type GrantRow } from './repositories/grants'
export { type AuthCodeRow, HandoffRepository } from './repositories/handoff'
export { PrincipalRepository, type PrincipalRow, type PrincipalStatus, principalStatus } from './repositories/principals'
export { type AuthenticationMethod, SessionRepository, type SessionRow } from './repositories/sessions'

/** IAM persistence capabilities selected together by a runtime composition root. */
export interface IamRepositories {
	principals: PrincipalRepository
	grants: GrantRepository
	appSchema: AppSchemaRepository
	credentials: CredentialRepository
	sessions: SessionRepository
	passwords: PasswordRepository
	handoff: HandoffRepository
	audit: AuditRepository
}

/** The portable repository bundle. A composition root may replace one complete capability. */
export function createIamRepositories(db: SqlDatabase, replacements: Partial<IamRepositories> = {}): IamRepositories {
	return {
		principals: replacements.principals ?? new PrincipalRepository(db),
		grants: replacements.grants ?? new GrantRepository(db),
		appSchema: replacements.appSchema ?? new AppSchemaRepository(db),
		credentials: replacements.credentials ?? new CredentialRepository(db),
		sessions: replacements.sessions ?? new SessionRepository(db),
		passwords: replacements.passwords ?? new PasswordRepository(db),
		handoff: replacements.handoff ?? new HandoffRepository(db),
		audit: replacements.audit ?? new AuditRepository(db),
	}
}
