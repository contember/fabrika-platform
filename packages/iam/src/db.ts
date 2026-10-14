import type { SqlDatabase } from '@fabrika/platform'
import { PasswordRepository } from './password-db'
import { AppSchemaRepository } from './repositories/app-schema'
import { AuditRepository, AuditWriter, type SqlDialect } from './repositories/audit'
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
	type AppMembersRow,
	AppSchemaRepository,
	type AppScopeRow,
	type DelegatedEndpointRow,
	type LinkMountRow,
	type RoleRow,
} from './repositories/app-schema'
export {
	type AuditedChange,
	type AuditEventInput,
	type AuditEventRow,
	auditEventStatement,
	auditLabelOf,
	AuditRepository,
	AuditWriter,
	type AuthLogInput,
	type AuthLogKind,
	type AuthLogRow,
	authLogStatement,
	type SqlChange,
	type SqlDialect,
} from './repositories/audit'
export { type CredentialGrantRow, CredentialRepository, type CredentialRow } from './repositories/credentials'
export { DeviceAuthorizationRepository, type DeviceAuthorizationRow, type DeviceReceiptRow } from './repositories/device'
export { ExternalGrantError, GrantRepository, type GrantRow } from './repositories/grants'
export { type AuthCodeRow, HandoffRepository } from './repositories/handoff'
export {
	type DelegationGrantRow,
	type InvitationAcceptance,
	type InvitationRow,
	type InviterCheck,
	type MemberGrantRow,
	MembershipRepository,
	type MembershipRepositoryOptions,
	type NewPrincipalAcceptance,
	type NewPrincipalEvents,
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

/**
 * The portable repository bundle. A composition root may replace one complete capability. `dialect` picks how a
 * guarded change writes its record (`AuditWriter`); everything else is the same SQL on both engines.
 */
export function createIamRepositories(
	db: SqlDatabase,
	replacements: Partial<IamRepositories> = {},
	dialect: SqlDialect = 'sqlite',
): IamRepositories {
	const writer = new AuditWriter(db, dialect)
	return {
		device: replacements.device ?? new DeviceAuthorizationRepository(db),
		principals: replacements.principals ?? new PrincipalRepository(db, writer),
		grants: replacements.grants ?? new GrantRepository(db, writer),
		appSchema: replacements.appSchema ?? new AppSchemaRepository(db, writer),
		credentials: replacements.credentials ?? new CredentialRepository(db, writer),
		sessions: replacements.sessions ?? new SessionRepository(db, writer),
		passwords: replacements.passwords ?? new PasswordRepository(db, writer),
		handoff: replacements.handoff ?? new HandoffRepository(db),
		membership: replacements.membership ?? new MembershipRepository(db, { dialect }),
		oauth: replacements.oauth ?? new OAuthRepository(db, writer),
		audit: replacements.audit ?? new AuditRepository(db, writer),
		workloads: replacements.workloads ?? new WorkloadRepository(db),
		membershipTransport: replacements.membershipTransport ?? new MembershipTransportKeyRepository(db),
	}
}

/** The bundle on Postgres: the same statements, recorded through one statement each, and the acceptance's row lock. */
export function createPostgresIamRepositories(db: SqlDatabase): IamRepositories {
	return createIamRepositories(db, {}, 'postgres')
}
