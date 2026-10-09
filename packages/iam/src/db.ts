import type { SqlDatabase } from '@fabrika/platform'
import { PasswordRepository } from './password-db'
import { AppSchemaRepository } from './repositories/app-schema'
import { AuditRepository } from './repositories/audit'
import { CredentialRepository } from './repositories/credentials'
import { DeviceAuthorizationRepository } from './repositories/device'
import { GrantRepository } from './repositories/grants'
import { HandoffRepository } from './repositories/handoff'
import { MembershipRepository } from './repositories/membership'
import { MembershipTransportKeyRepository } from './repositories/membership-transport'
import { OAuthRepository } from './repositories/oauth'
import { PrincipalRepository } from './repositories/principals'
import { SessionRepository } from './repositories/sessions'
import { WorkloadRepository } from './repositories/workloads'

export {
	type AppActionRow,
	AppSchemaRepository,
	type AppScopeRow,
	type DelegatedEndpointRow,
	type LinkMountRow,
	type RoleRow,
} from './repositories/app-schema'
export { type AuditEventInput, type AuditEventRow, AuditRepository, type AuthLogInput, type AuthLogRow } from './repositories/audit'
export { type CredentialGrantRow, CredentialRepository, type CredentialRow } from './repositories/credentials'
export { DeviceAuthorizationRepository, type DeviceAuthorizationRow, type DeviceReceiptRow } from './repositories/device'
export { GrantRepository, type GrantRow } from './repositories/grants'
export { type AuthCodeRow, HandoffRepository } from './repositories/handoff'
export {
	type DelegationGrantRow,
	type InvitationAcceptance,
	type InvitationRow,
	type MemberGrantRow,
	MembershipRepository,
	type MembershipRepositoryOptions,
} from './repositories/membership'
export { MembershipTransportKeyRepository, type MembershipTransportKeyRow } from './repositories/membership-transport'
export { type OAuthCodeRow, type OAuthGrantRow, type OAuthRefreshTokenRow, OAuthRepository } from './repositories/oauth'
export { PrincipalRepository, type PrincipalRow, type PrincipalStatus, principalStatus } from './repositories/principals'
export { type AuthenticationMethod, SessionRepository, type SessionRow } from './repositories/sessions'
export { type AppWorkloadRow, type WorkloadPrincipalRow, WorkloadRepository } from './repositories/workloads'

/** IAM persistence capabilities selected together by a runtime composition root. */
export interface IamRepositories {
	device: DeviceAuthorizationRepository
	principals: PrincipalRepository
	grants: GrantRepository
	appSchema: AppSchemaRepository
	credentials: CredentialRepository
	sessions: SessionRepository
	passwords: PasswordRepository
	handoff: HandoffRepository
	membership: MembershipRepository
	oauth: OAuthRepository
	audit: AuditRepository
	workloads: WorkloadRepository
	membershipTransport: MembershipTransportKeyRepository
}

/** The portable repository bundle. A composition root may replace one complete capability. */
export function createIamRepositories(db: SqlDatabase, replacements: Partial<IamRepositories> = {}): IamRepositories {
	return {
		device: replacements.device ?? new DeviceAuthorizationRepository(db),
		principals: replacements.principals ?? new PrincipalRepository(db),
		grants: replacements.grants ?? new GrantRepository(db),
		appSchema: replacements.appSchema ?? new AppSchemaRepository(db),
		credentials: replacements.credentials ?? new CredentialRepository(db),
		sessions: replacements.sessions ?? new SessionRepository(db),
		passwords: replacements.passwords ?? new PasswordRepository(db),
		handoff: replacements.handoff ?? new HandoffRepository(db),
		membership: replacements.membership ?? new MembershipRepository(db),
		oauth: replacements.oauth ?? new OAuthRepository(db),
		audit: replacements.audit ?? new AuditRepository(db),
		workloads: replacements.workloads ?? new WorkloadRepository(db),
		membershipTransport: replacements.membershipTransport ?? new MembershipTransportKeyRepository(db),
	}
}

/** The bundle on Postgres: the same statements, plus the row lock an acceptance takes on the inviter's grant. */
export function createPostgresIamRepositories(db: SqlDatabase): IamRepositories {
	return createIamRepositories(db, { membership: new MembershipRepository(db, { lockInviterGrant: true }) })
}
