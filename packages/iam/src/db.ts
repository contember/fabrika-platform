import type { SqlDatabase } from '@fabrika/platform'
import { PasswordRepository } from './password-db'
import { AppSchemaRepository } from './repositories/app-schema'
import { AuditRepository, AuditWriter, type SqlDialect } from './repositories/audit'
import { InstallationBrandRepository } from './repositories/brand'
import { CredentialRepository } from './repositories/credentials'
import { DeviceAuthorizationRepository } from './repositories/device'
import { GrantRequestRepository } from './repositories/grant-requests'
import { GrantRepository } from './repositories/grants'
import { HandoffRepository } from './repositories/handoff'
import { MembershipRepository } from './repositories/membership'
import { MembershipTransportKeyRepository } from './repositories/membership-transport'
import { OAuthRepository } from './repositories/oauth'
import { OAuthRegistryRepository } from './repositories/oauth-registry'
import { PasskeyRepository } from './repositories/passkeys'
import { PasswordPolicyRepository } from './repositories/password-policy'
import { PrincipalRepository } from './repositories/principals'
import { SecondFactorRepository } from './repositories/second-factors'
import { SessionRepository } from './repositories/sessions'
import { TerminalRepository } from './repositories/terminals'
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
export { type InstallationBrandImages, InstallationBrandRepository, type InstallationBrandRow } from './repositories/brand'
export { type CredentialGrantRow, CredentialRepository, type CredentialRow, type RequestedApiKeyRow } from './repositories/credentials'
export { DeviceAuthorizationRepository, type DeviceAuthorizationRow, type DeviceReceiptRow } from './repositories/device'
export { type CreateGrantRequestInput, GrantRequestRepository, type GrantRequestRow } from './repositories/grant-requests'
export { type DelegatedAuthority, ExternalGrantError, GrantRepository, type GrantRow, type GrantSetRead } from './repositories/grants'
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
export {
	type AuthoringClientWrite,
	ExternalAppResourceTaken,
	type ExternalAppRevocation,
	type ExternalAppRow,
	type ExternalAppWrite,
	type OAuthClientRow,
	OAuthRegistryRepository,
	type RegistryEvents,
} from './repositories/oauth-registry'
export { PasskeyRepository, type PasskeyRow } from './repositories/passkeys'
export { PasswordPolicyRepository, type PasswordPolicyRow } from './repositories/password-policy'
export { PrincipalRepository, type PrincipalRow, type PrincipalStatus, principalStatus } from './repositories/principals'
export { SecondFactorRepository, type SecondFactorRow, type SecondFactorStatus } from './repositories/second-factors'
export {
	type AuthenticationMethod,
	SessionRepository,
	type SessionRow,
	type SessionTerminal,
	sessionTerminal,
	type SignedInSessionRow,
} from './repositories/sessions'
export {
	DEFAULT_TERMINAL_SESSION_TTL_SECONDS,
	MAX_TERMINAL_SESSION_TTL_SECONDS,
	type TerminalAsserter,
	type TerminalIdentificationRow,
	type TerminalProfile,
	TerminalRepository,
	type TerminalRow,
} from './repositories/terminals'
export { type AppWorkloadRow, type WorkloadPrincipalRow, WorkloadRepository } from './repositories/workloads'

/** IAM persistence capabilities selected together by a runtime composition root. */
export interface IamRepositories {
	device: DeviceAuthorizationRepository
	principals: PrincipalRepository
	grants: GrantRepository
	grantRequests: GrantRequestRepository
	appSchema: AppSchemaRepository
	credentials: CredentialRepository
	sessions: SessionRepository
	passwords: PasswordRepository
	handoff: HandoffRepository
	membership: MembershipRepository
	oauth: OAuthRepository
	oauthRegistry: OAuthRegistryRepository
	audit: AuditRepository
	workloads: WorkloadRepository
	terminals: TerminalRepository
	membershipTransport: MembershipTransportKeyRepository
	brand: InstallationBrandRepository
	passwordPolicy: PasswordPolicyRepository
	secondFactors: SecondFactorRepository
	passkeys: PasskeyRepository
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
	const appSchema = replacements.appSchema ?? new AppSchemaRepository(db, writer)
	return {
		device: replacements.device ?? new DeviceAuthorizationRepository(db),
		principals: replacements.principals ?? new PrincipalRepository(db, writer),
		grants: replacements.grants ?? new GrantRepository(db, writer),
		grantRequests: replacements.grantRequests ?? new GrantRequestRepository(db, writer),
		appSchema,
		credentials: replacements.credentials ?? new CredentialRepository(db, writer),
		sessions: replacements.sessions ?? new SessionRepository(db, writer),
		passwords: replacements.passwords ?? new PasswordRepository(db, writer),
		handoff: replacements.handoff ?? new HandoffRepository(db),
		membership: replacements.membership ?? new MembershipRepository(db, { dialect }),
		oauth: replacements.oauth ?? new OAuthRepository(db, writer),
		oauthRegistry: replacements.oauthRegistry ?? new OAuthRegistryRepository(db, writer, appSchema),
		audit: replacements.audit ?? new AuditRepository(db, writer),
		workloads: replacements.workloads ?? new WorkloadRepository(db),
		terminals: replacements.terminals ?? new TerminalRepository(db, writer),
		membershipTransport: replacements.membershipTransport ?? new MembershipTransportKeyRepository(db),
		brand: replacements.brand ?? new InstallationBrandRepository(db, writer),
		passwordPolicy: replacements.passwordPolicy ?? new PasswordPolicyRepository(db, writer),
		secondFactors: replacements.secondFactors ?? new SecondFactorRepository(db, writer),
		passkeys: replacements.passkeys ?? new PasskeyRepository(db, writer),
	}
}

/** The bundle on Postgres: the same statements, recorded through one statement each, and the acceptance's row lock. */
export function createPostgresIamRepositories(db: SqlDatabase): IamRepositories {
	return createIamRepositories(db, {}, 'postgres')
}
