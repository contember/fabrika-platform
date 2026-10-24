import type { PrincipalAffiliation, Scope } from '@fabrika/auth-core'
import { type SqlDatabase, type SqlQueryResult, type SqlStatement, uuidv7 } from '@fabrika/platform'
import type { StoredPasswordHash } from '../password-crypto'
import { type AuditEventInput, auditEventStatement, AuditWriter, type SqlChange, type SqlDialect } from './audit'
import { eligibleGrantBinds, eligibleGrantSql, grantRemovalStatement, type GrantRow } from './grants'
import type { PrincipalRow } from './principals'
import { unixNow } from './sql'

/** A single-use delegation grant (`delegation_grants`). Only its hash is stored. */
export interface DelegationGrantRow {
	id: string
	grant_hash: string
	app: string
	principal_id: string
	endpoint: string
	request_id: string
	expires_at: number
	consumed_at: number | null
	created_at: number
}

/** An invitation to a membership role (`membership_invitations`). `email` is the normalized mailbox. */
export interface InvitationRow {
	id: string
	token_hash: string
	app: string
	scope_type: string
	scope_value: string
	role_key: string
	email: string
	invited_by: string
	expires_at: number
	accepted_at: number | null
	accepted_by: string | null
	acceptance_id: string | null
	revoked_at: number | null
	created_at: number
	/** The invited person's company as the inviting application names it (plain text), or NULL. */
	company_label: string | null
	/** The inviter's personal message (plain text), or NULL. */
	message: string | null
}

/** One membership-role grant in a value, with the principal it belongs to and its last sign-in to the app. */
export interface MemberGrantRow {
	principal_id: string
	role_key: string
	label: string
	email: string | null
	disabled_at: number | null
	affiliation: PrincipalAffiliation
	signed_in_at: number | null
}

/** One role grant at an application, in a value or global, with its principal and its last sign-in there. */
export interface AppMemberGrantRow extends MemberGrantRow {
	scope_type: string | null
	scope_value: string | null
}

/**
 * The grants that count as holding a role of the application: an active grant of a role row of the app, a membership
 * role only in a value of its own dimension, and an external principal's only of a role declared external, as
 * `computePermissions` counts them.
 */
const APP_MEMBER_GRANT = `g.app = ? AND (g.expires_at IS NULL OR g.expires_at > ?)
	AND (r.member_scope IS NULL OR r.member_scope = g.scope_type)
	AND (p.affiliation = 'internal' OR r.external = 1)`

/**
 * The rows behind the membership operations. Membership itself is ordinary role grants scoped to a value,
 * so a group assignment (backlog 91) can sit next to them later; this repository adds the values IAM
 * created, the single-use delegation grants and the invitations.
 */
/**
 * The conflict clause of every membership-role grant write. An ACTIVE grant of the role in the value is
 * kept as it is, which makes a repeated assignment answer the same result; an EXPIRED one is renewed in
 * the same statement, so it never reads as held while it grants nothing. A renewal takes the new grant's expiry, which
 * the use case clamped to the authority that gave it (S8).
 */
const RENEW_EXPIRED_MEMBERSHIP = `ON CONFLICT (principal_id, role_key, scope_type, scope_value, COALESCE(app, '*'))
	WHERE role_key IS NOT NULL AND scope_value IS NOT NULL
	DO UPDATE SET expires_at = excluded.expires_at, granted_by = excluded.granted_by, created_at = excluded.created_at
	WHERE grants.expires_at IS NOT NULL AND grants.expires_at <= ?`

/**
 * How an acceptance ended: written; refused because the inviter holds no assigning role there now, or because the
 * accepting principal may not hold the role (ADR-0051); or no longer open.
 */
/**
 * The grants that make their holder an assigner in the value bound next (type, value): a role grant in exactly that
 * value, or a global grant of an application-wide role, one with no `member_scope` (ADR-0022 rule 6).
 */
const ASSIGNING_GRANT = `((grants.scope_type = ? AND grants.scope_value = ?)
	OR (grants.scope_type IS NULL AND grants.scope_value IS NULL AND EXISTS (
		SELECT 1 FROM roles WHERE roles.app = grants.app AND roles.role_key = grants.role_key AND roles.member_scope IS NULL)))`

export type InvitationAcceptance = 'accepted' | 'not_allowed' | 'not_eligible' | 'not_open'

/**
 * How an acceptance that creates its principal ended: accepted with the new principal; refused as `acceptInvitation`
 * refuses; or `account_exists`, because another writer gave the mailbox a principal first, which then signs in and
 * accepts as any existing principal does.
 */
export type NewPrincipalAcceptance =
	| { readonly outcome: 'accepted'; readonly principal: PrincipalRow }
	| { readonly outcome: Exclude<InvitationAcceptance, 'accepted'> | 'account_exists' }

/**
 * What authorized an acceptance, as the use case checked it: the roles that make the inviter an assigner of the
 * invitation's role, the revision of the app's schema and policies (`AppSchemaRepository.getSchemaRevision`) and the
 * inviter's grant revision (`principals.grant_revision`), both read BEFORE that check. The acceptance writes only while
 * both are unchanged, so the declarations and the grants the check read are the ones in force at the write.
 */
export interface InviterCheck {
	readonly assigners: readonly string[]
	readonly revision: number
	readonly grantRevision: number
	/** The expiry of the grant the acceptance writes: the earliest expiry among the inviter's grants behind it (S8). */
	readonly expiresAt: number | null
}

/** The records of an acceptance that creates its principal, each written exactly when its change was. */
export interface NewPrincipalEvents {
	readonly principal: AuditEventInput
	readonly acceptance: AuditEventInput
	readonly password: AuditEventInput
}

export interface MembershipRepositoryOptions {
	/**
	 * The dialect of `db`. On Postgres an acceptance locks the inviter's assigning grant while it commits (`FOR SHARE`),
	 * so a removal of that grant waits for it; SQLite has no row locks, and D1 runs a batch alone, which is atomic
	 * already. It also picks how a change writes its record (`AuditWriter`).
	 */
	readonly dialect?: SqlDialect
}

export class MembershipRepository {
	/** `FOR SHARE` on Postgres: an acceptance holds the inviter's assigning grant and the role row to its commit. */
	readonly #shareLock: string
	/** `eligibleGrantSql` of the dialect: on Postgres it holds the role row for the transaction. */
	readonly #eligible: string
	protected readonly writer: AuditWriter

	constructor(
		protected readonly db: SqlDatabase,
		options: MembershipRepositoryOptions = {},
	) {
		const dialect = options.dialect ?? 'sqlite'
		this.#shareLock = dialect === 'postgres' ? 'FOR SHARE' : ''
		this.#eligible = eligibleGrantSql(dialect)
		this.writer = new AuditWriter(db, dialect)
	}

	async issueDelegationGrant(input: {
		grantHash: string
		app: string
		principalId: string
		endpoint: string
		requestId: string
		expiresAt: number
	}): Promise<void> {
		await this.db
			.prepare(`INSERT INTO delegation_grants (id, grant_hash, app, principal_id, endpoint, request_id, expires_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(uuidv7(), input.grantHash, input.app, input.principalId, input.endpoint, input.requestId, input.expiresAt, unixNow())
			.run()
	}

	/**
	 * Spend a delegation grant, at most once. The UPDATE is the guard, as for `auth_codes`: a second
	 * attempt changes no rows. The caller compares the binding AFTER this, so a mismatched attempt spends it too.
	 */
	async consumeDelegationGrant(grantHash: string, now: number): Promise<DelegationGrantRow | null> {
		const marked = await this.db
			.prepare('UPDATE delegation_grants SET consumed_at = ? WHERE grant_hash = ? AND consumed_at IS NULL AND expires_at > ?')
			.bind(now, grantHash, now)
			.run()
		if (marked.meta.changes === 0) {
			return null
		}
		return this.db.prepare('SELECT * FROM delegation_grants WHERE grant_hash = ?').bind(grantHash).first<DelegationGrantRow>()
	}

	/**
	 * Record a value IAM generated, grant its creator the creator role, and write `audit`, in one transaction. Both writes
	 * carry the eligibility condition (ADR-0051), so a creator who may not hold the role writes nothing: answers false.
	 */
	async createScope(
		input: { app: string; scope: Scope; createdBy: string; roleKey: string; expiresAt?: number | null },
		audit?: AuditEventInput,
	): Promise<boolean> {
		const now = unixNow()
		const eligible = eligibleGrantBinds({ principalId: input.createdBy, app: input.app, roleKey: input.roleKey })
		const created = this.writer.changed([
			{
				sql: `INSERT INTO membership_scopes (app, scope_type, scope_value, created_by, created_at)
					SELECT ?, ?, ?, ?, ? WHERE ${this.#eligible} RETURNING scope_value`,
				binds: [input.app, input.scope.type, input.scope.value, input.createdBy, now, ...eligible],
			},
			{
				sql: `INSERT INTO grants (id, principal_id, app, role_key, permissions, scope_type, scope_value, granted_by, expires_at, created_at)
					SELECT ?, ?, ?, ?, NULL, ?, ?, ?, ?, ? WHERE ${this.#eligible} RETURNING id`,
				binds: [
					uuidv7(),
					input.createdBy,
					input.app,
					input.roleKey,
					input.scope.type,
					input.scope.value,
					input.createdBy,
					input.expiresAt ?? null,
					now,
					...eligible,
				],
			},
		], audit)
		return created.rows(await this.db.batch(created.statements)).length > 0
	}

	/** The active role grants a principal holds in exactly `scope` — the roles it holds "there". */
	async listRoleGrantsAt(app: string, principalId: string, scope: Scope): Promise<GrantRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM grants
				WHERE app = ? AND principal_id = ? AND role_key IS NOT NULL AND scope_type = ? AND scope_value = ?
					AND (expires_at IS NULL OR expires_at > ?)
				ORDER BY role_key`)
			.bind(app, principalId, scope.type, scope.value, unixNow())
			.all<GrantRow>()
		return results
	}

	/** The active role grants that make a principal an assigner in `scope` (`ASSIGNING_GRANT`). */
	async listAssigningGrants(app: string, principalId: string, scope: Scope): Promise<GrantRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM grants
				WHERE app = ? AND principal_id = ? AND role_key IS NOT NULL AND ${ASSIGNING_GRANT}
					AND (expires_at IS NULL OR expires_at > ?)
				ORDER BY role_key`)
			.bind(app, principalId, scope.type, scope.value, unixNow())
			.all<GrantRow>()
		return results
	}

	/** Every active grant of a membership role of `scope.type` in `scope`, with its principal. */
	async listMemberGrants(app: string, scope: Scope): Promise<MemberGrantRow[]> {
		const { results } = await this.db
			.prepare(`SELECT g.principal_id, g.role_key, p.label, p.email, p.disabled_at, p.affiliation, si.signed_in_at
				FROM grants g
				JOIN principals p ON p.id = g.principal_id
				JOIN roles r ON r.app = g.app AND r.role_key = g.role_key
				LEFT JOIN app_sign_ins si ON si.app = g.app AND si.principal_id = g.principal_id
				WHERE g.app = ? AND g.scope_type = ? AND g.scope_value = ? AND r.member_scope = ?
					AND (g.expires_at IS NULL OR g.expires_at > ?)
				ORDER BY g.principal_id, g.role_key`)
			.bind(app, scope.type, scope.value, scope.type, unixNow())
			.all<MemberGrantRow>()
		return results
	}

	/** A page of the principals holding a role of `app` (`APP_MEMBER_GRANT`), by id after `after`, at most `limit`. */
	async listAppMemberIds(app: string, after: string | null, limit: number): Promise<string[]> {
		const page = after === null ? '' : 'AND g.principal_id > ?'
		const { results } = await this.db
			.prepare(`SELECT DISTINCT g.principal_id
				FROM grants g
				JOIN principals p ON p.id = g.principal_id
				JOIN roles r ON r.app = g.app AND r.role_key = g.role_key
				WHERE ${APP_MEMBER_GRANT} ${page}
				ORDER BY g.principal_id
				LIMIT ?`)
			.bind(app, unixNow(), ...(after === null ? [] : [after]), limit)
			.all<{ principal_id: string }>()
		return results.map((row) => row.principal_id)
	}

	/** The grants of `principalIds` that make them people of `app` (`APP_MEMBER_GRANT`), with each principal. */
	async listAppMemberGrants(app: string, principalIds: readonly string[]): Promise<AppMemberGrantRow[]> {
		if (principalIds.length === 0) return []
		const { results } = await this.db
			.prepare(`SELECT g.principal_id, g.role_key, g.scope_type, g.scope_value, p.label, p.email, p.disabled_at, p.affiliation, si.signed_in_at
				FROM grants g
				JOIN principals p ON p.id = g.principal_id
				JOIN roles r ON r.app = g.app AND r.role_key = g.role_key
				LEFT JOIN app_sign_ins si ON si.app = g.app AND si.principal_id = g.principal_id
				WHERE ${APP_MEMBER_GRANT} AND g.principal_id IN (${principalIds.map(() => '?').join(', ')})
				ORDER BY g.principal_id, g.role_key`)
			.bind(app, unixNow(), ...principalIds)
			.all<AppMemberGrantRow>()
		return results
	}

	/** Every active grant of a membership role of `scope.type` in `scope` held by `principalId`, with the principal. */
	async listMemberGrantsOf(app: string, scope: Scope, principalId: string): Promise<MemberGrantRow[]> {
		const { results } = await this.db
			.prepare(`SELECT g.principal_id, g.role_key, p.label, p.email, p.disabled_at, p.affiliation, si.signed_in_at
				FROM grants g
				JOIN principals p ON p.id = g.principal_id
				JOIN roles r ON r.app = g.app AND r.role_key = g.role_key
				LEFT JOIN app_sign_ins si ON si.app = g.app AND si.principal_id = g.principal_id
				WHERE g.app = ? AND g.scope_type = ? AND g.scope_value = ? AND r.member_scope = ? AND g.principal_id = ?
					AND (g.expires_at IS NULL OR g.expires_at > ?)
				ORDER BY g.role_key`)
			.bind(app, scope.type, scope.value, scope.type, principalId, unixNow())
			.all<MemberGrantRow>()
		return results
	}

	/**
	 * Grant a membership role in `scope`. Returns the row when this call granted or renewed it, null when it was held or
	 * the principal may not hold it (ADR-0051: the insert carries the condition); `audit` is written exactly then.
	 */
	async grantMembershipRole(
		input: { app: string; principalId: string; roleKey: string; scope: Scope; grantedBy: string; expiresAt?: number | null },
		audit?: AuditEventInput,
	): Promise<GrantRow | null> {
		const now = unixNow()
		const grant: SqlChange = {
			sql: `INSERT INTO grants (id, principal_id, app, role_key, permissions, scope_type, scope_value, granted_by, expires_at, created_at)
				SELECT ?, ?, ?, ?, NULL, ?, ?, ?, ?, ? WHERE ${this.#eligible} ${RENEW_EXPIRED_MEMBERSHIP} RETURNING *`,
			binds: [
				uuidv7(),
				input.principalId,
				input.app,
				input.roleKey,
				input.scope.type,
				input.scope.value,
				input.grantedBy,
				input.expiresAt ?? null,
				now,
				...eligibleGrantBinds(input),
				now,
			],
		}
		const [granted] = await this.writer.run<GrantRow>([grant], audit)
		return granted ?? null
	}

	/** Remove one role grant of a principal in `scope`, after its grant revision (`grantRemovalStatement`). Returns whether a row went. */
	async deleteRoleGrant(app: string, principalId: string, roleKey: string, scope: Scope): Promise<boolean> {
		const [, deleted] = await this.db.batch<{ id: string }>([
			grantRemovalStatement(this.db, { principalId }),
			this.db
				.prepare('DELETE FROM grants WHERE app = ? AND principal_id = ? AND role_key = ? AND scope_type = ? AND scope_value = ? RETURNING id')
				.bind(app, principalId, roleKey, scope.type, scope.value),
		])
		return (deleted?.results.length ?? 0) > 0
	}

	/**
	 * Remove a principal's creator-role grant in `scope` only while another principal still holds the role
	 * there. The value's `membership_scopes` row is the lock: created on demand, because an administrator
	 * may have granted the role without `createScope`, then taken with a row-locking UPDATE — the one lock
	 * statement SQLite and Postgres share; D1 runs a batch serially anyway. Two revokes of the last two
	 * holders therefore run one after the other, and the second sees the first's delete. The principal's
	 * grant revision moves first (`grantRemovalStatement`), so its row is locked before the value's.
	 */
	async deleteCreatorGrantUnlessLast(app: string, principalId: string, roleKey: string, scope: Scope): Promise<boolean> {
		const remove = this.deleteCreatorChange(app, principalId, roleKey, scope, unixNow())
		const [, , , deleted] = await this.db.batch<{ role_key: string }>([
			grantRemovalStatement(this.db, { principalId }),
			...this.scopeLockStatements(app, scope),
			this.db.prepare(remove.sql).bind(...remove.binds),
		])
		return (deleted?.results.length ?? 0) > 0
	}

	/**
	 * Remove a member's roles in `scope`, in one transaction under the value's lock (`deleteCreatorGrantUnlessLast`),
	 * writing one `audit` row per role this call removed, decided by each DELETE itself. The creator role goes only
	 * while another principal holds it, and while the member still holds it no other role goes either, so a refused
	 * creator leaves every role in place. Answers the roles removed.
	 */
	async revokeMemberRoles(
		input: { app: string; principalId: string; scope: Scope; roles: readonly string[]; creatorRole: string | null },
		audit: (roleKey: string) => AuditEventInput,
	): Promise<string[]> {
		const { app, principalId, scope } = input
		const now = unixNow()
		const creator = input.creatorRole !== null && input.roles.includes(input.creatorRole) ? input.creatorRole : null
		const groups = [
			...(creator === null ? [] : [this.writer.changed([this.deleteCreatorChange(app, principalId, creator, scope, now)], audit(creator))]),
			...input.roles.filter((roleKey) => roleKey !== creator).map((roleKey) => {
				// While the member still holds an active creator grant here, no other role of it goes.
				const creatorHeld = creator === null ? '' : `AND NOT EXISTS (SELECT 1 FROM grants
					WHERE app = ? AND principal_id = ? AND role_key = ? AND scope_type = ? AND scope_value = ?
						AND (expires_at IS NULL OR expires_at > ?))`
				const remove: SqlChange = {
					sql: `DELETE FROM grants WHERE app = ? AND principal_id = ? AND role_key = ? AND scope_type = ? AND scope_value = ?
						${creatorHeld} RETURNING role_key`,
					binds: [
						app,
						principalId,
						roleKey,
						scope.type,
						scope.value,
						...(creator === null ? [] : [app, principalId, creator, scope.type, scope.value, now]),
					],
				}
				return this.writer.changed([remove], audit(roleKey))
			}),
		]
		const lock = [grantRemovalStatement(this.db, { principalId }), ...this.scopeLockStatements(app, scope)]
		const results = await this.db.batch<{ role_key: string }>([...lock, ...groups.flatMap((group) => group.statements)])
		let offset = lock.length
		const removed: string[] = []
		for (const group of groups) {
			removed.push(...group.rows(results, offset).map((row) => row.role_key))
			offset += group.statements.length
		}
		return removed
	}

	/** Create the value's `membership_scopes` row on demand and lock it; see `deleteCreatorGrantUnlessLast`. */
	private scopeLockStatements(app: string, scope: Scope): SqlStatement[] {
		return [
			this.db
				.prepare(`INSERT INTO membership_scopes (app, scope_type, scope_value, created_by, created_at) VALUES (?, ?, ?, NULL, ?)
					ON CONFLICT (app, scope_type, scope_value) DO NOTHING`)
				.bind(app, scope.type, scope.value, unixNow()),
			this.db
				.prepare('UPDATE membership_scopes SET created_at = created_at WHERE app = ? AND scope_type = ? AND scope_value = ?')
				.bind(app, scope.type, scope.value),
		]
	}

	/** The DELETE of a principal's creator grant in `scope`, only while another principal holds the role there. */
	private deleteCreatorChange(app: string, principalId: string, roleKey: string, scope: Scope, now: number): SqlChange {
		return {
			sql: `DELETE FROM grants
				WHERE app = ? AND principal_id = ? AND role_key = ? AND scope_type = ? AND scope_value = ?
					AND EXISTS (
						SELECT 1 FROM grants other
						WHERE other.app = ? AND other.role_key = ? AND other.scope_type = ? AND other.scope_value = ?
							AND other.principal_id <> ? AND (other.expires_at IS NULL OR other.expires_at > ?))
				RETURNING role_key`,
			binds: [app, principalId, roleKey, scope.type, scope.value, app, roleKey, scope.type, scope.value, principalId, now],
		}
	}

	/**
	 * Open an invitation, or answer the open one for the same value, role and mailbox. An expired open
	 * invitation is closed first, so it never blocks a new one. `audit` is written exactly when this call opened one.
	 */
	async openInvitation(input: {
		tokenHash: string
		app: string
		scope: Scope
		roleKey: string
		email: string
		invitedBy: string
		expiresAt: number
		companyLabel?: string | null
		message?: string | null
	}, audit?: (invitationId: string) => AuditEventInput): Promise<{ invitation: InvitationRow; created: boolean }> {
		const now = unixNow()
		const id = uuidv7()
		const key = [input.app, input.scope.type, input.scope.value, input.roleKey, input.email]
		const opened = this.writer.changed([{
			sql: `INSERT INTO membership_invitations
					(id, token_hash, app, scope_type, scope_value, role_key, email, invited_by, expires_at, created_at, company_label, message)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (app, scope_type, scope_value, role_key, email) WHERE accepted_at IS NULL AND revoked_at IS NULL DO NOTHING
				RETURNING *`,
			binds: [id, input.tokenHash, ...key, input.invitedBy, input.expiresAt, now, input.companyLabel ?? null, input.message ?? null],
		}], audit?.(id))
		const results = await this.db.batch<InvitationRow>([
			this.db
				.prepare(`UPDATE membership_invitations SET revoked_at = ?
					WHERE app = ? AND scope_type = ? AND scope_value = ? AND role_key = ? AND email = ?
						AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= ?`)
				.bind(now, ...key, now),
			...opened.statements,
		])
		const created = opened.rows(results, 1)[0] ?? null
		if (created !== null) {
			return { invitation: created, created: true }
		}
		const open = await this.db
			.prepare(`SELECT * FROM membership_invitations
				WHERE app = ? AND scope_type = ? AND scope_value = ? AND role_key = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL`)
			.bind(...key)
			.first<InvitationRow>()
		if (open === null) {
			throw new Error('an open invitation conflicted and then vanished')
		}
		return { invitation: open, created: false }
	}

	/**
	 * Give an open invitation a new link and a new lifetime (a resend): the old token's hash is replaced, so its link
	 * stops working. A label or message the call names replaces the stored one; NULL keeps it. Answers the invitation
	 * when it was still open, and `audit` is written exactly then.
	 */
	async rotateInvitation(
		input: { id: string; tokenHash: string; expiresAt: number; companyLabel: string | null; message: string | null },
		audit?: AuditEventInput,
	): Promise<InvitationRow | null> {
		const now = unixNow()
		const rotate: SqlChange = {
			sql: `UPDATE membership_invitations
				SET token_hash = ?, expires_at = ?, company_label = COALESCE(?, company_label), message = COALESCE(?, message)
				WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
				RETURNING *`,
			binds: [input.tokenHash, input.expiresAt, input.companyLabel, input.message, input.id, now],
		}
		const [rotated] = await this.writer.run<InvitationRow>([rotate], audit)
		return rotated ?? null
	}

	async getInvitationByHash(tokenHash: string): Promise<InvitationRow | null> {
		return this.db.prepare('SELECT * FROM membership_invitations WHERE token_hash = ?').bind(tokenHash).first<InvitationRow>()
	}

	async getInvitationById(id: string): Promise<InvitationRow | null> {
		return this.db.prepare('SELECT * FROM membership_invitations WHERE id = ?').bind(id).first<InvitationRow>()
	}

	/** Remove an invitation whose email could not be delivered, so a retry opens a fresh one; `audit` records the removal. */
	async deleteInvitation(id: string, audit?: AuditEventInput): Promise<void> {
		const remove = this.db.prepare('DELETE FROM membership_invitations WHERE id = ?').bind(id)
		await this.db.batch(audit === undefined ? [remove] : [remove, auditEventStatement(this.db, audit)])
	}

	/** Close an open invitation. Answers whether it was still open; `audit` is written exactly then. */
	async revokeInvitation(id: string, audit?: AuditEventInput): Promise<boolean> {
		const revoke: SqlChange = {
			sql: 'UPDATE membership_invitations SET revoked_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id',
			binds: [unixNow(), id],
		}
		return (await this.writer.run([revoke], audit)).length > 0
	}

	/**
	 * Accept an invitation for `principalId` and write its grant, in one transaction. The guarded UPDATE
	 * stamps a fresh acceptance id on the invitation only when it is still open under this token AND the authority the
	 * use case checked still holds (`checkedAuthority`): the inviter enabled, the app's schema revision unchanged, and
	 * one of the assigners held in the value or, an application-wide role, globally (`ASSIGNING_GRANT`). The re-check
	 * is part of the statement that consumes the invitation, so a removal or disable of the inviter, or a reconcile,
	 * cannot land between a check and the write. The grant is written
	 * only for the attempt holding that id — never on the strength of a timestamp another attempt can share.
	 * An expired grant of the role is renewed; an active one is left as it is. A refused acceptance leaves the
	 * invitation open. `audit` is written only for the attempt holding the acceptance id, in the same batch.
	 */
	async acceptInvitation(
		invitation: InvitationRow,
		principalId: string,
		inviter: InviterCheck,
		audit?: AuditEventInput,
	): Promise<InvitationAcceptance> {
		if (inviter.assigners.length === 0) {
			return 'not_allowed'
		}
		const now = unixNow()
		const acceptanceId = uuidv7()
		const authority = this.checkedAuthority(invitation, inviter, now)
		const accept = this.writer.changed([{
			sql: `UPDATE membership_invitations SET accepted_at = ?, accepted_by = ?, acceptance_id = ?
				WHERE id = ? AND token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
					AND ${authority.sql}
					AND ${this.#eligible}
				RETURNING id`,
			binds: [
				now,
				principalId,
				acceptanceId,
				invitation.id,
				invitation.token_hash,
				now,
				...authority.binds,
				...eligibleGrantBinds({ principalId, app: invitation.app, roleKey: invitation.role_key }),
			],
		}], audit)
		const statements = [
			...authority.locks,
			...accept.statements,
			this.db
				.prepare(`INSERT INTO grants (id, principal_id, app, role_key, permissions, scope_type, scope_value, granted_by, expires_at, created_at)
					SELECT ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?
					WHERE EXISTS (SELECT 1 FROM membership_invitations WHERE id = ? AND acceptance_id = ?) AND ${this.#eligible}
					${RENEW_EXPIRED_MEMBERSHIP}`)
				.bind(
					uuidv7(),
					principalId,
					invitation.app,
					invitation.role_key,
					invitation.scope_type,
					invitation.scope_value,
					invitation.invited_by,
					inviter.expiresAt,
					now,
					invitation.id,
					acceptanceId,
					...eligibleGrantBinds({ principalId, app: invitation.app, roleKey: invitation.role_key }),
					now,
				),
			// The acceptance holds the grant it promised or does not happen: this NOT NULL violation rolls the batch back,
			// invitation and record included, when the attempt holding the acceptance id has no active grant of the role.
			this.db
				.prepare(`INSERT INTO contract_apps (app, created_at) SELECT ?, NULL
					WHERE EXISTS (SELECT 1 FROM membership_invitations WHERE id = ? AND acceptance_id = ?)
						AND NOT EXISTS (
							SELECT 1 FROM grants
							WHERE principal_id = ? AND app = ? AND role_key = ? AND scope_type = ? AND scope_value = ?
								AND (expires_at IS NULL OR expires_at > ?))`)
				.bind(
					`${invitation.app}#acceptance-without-grant`,
					invitation.id,
					acceptanceId,
					principalId,
					invitation.app,
					invitation.role_key,
					invitation.scope_type,
					invitation.scope_value,
					now,
				),
		]
		let accepted: boolean
		try {
			accepted = accept.rows(await this.db.batch<{ id: string }>(statements), authority.locks.length).length > 0
		} catch (cause) {
			if (await this.ineligible(invitation, principalId)) return 'not_eligible'
			throw cause
		}
		if (accepted) {
			return 'accepted'
		}
		const current = await this.getInvitationById(invitation.id)
		const open = current !== null && current.accepted_at === null && current.revoked_at === null && current.expires_at > now
		if (!open) return 'not_open'
		return (await this.ineligible(invitation, principalId)) ? 'not_eligible' : 'not_allowed'
	}

	/**
	 * Accept an invitation to a role declared external for a mailbox no principal holds, creating its principal, in ONE
	 * transaction: an `external` user labelled with the invited address, active, with its mailbox claimed; the
	 * acceptance and its grant as `acceptInvitation` writes them; an enabled password account holding `password`; and the
	 * three records. After the inviter's locks (`checkedAuthority`), the new principal's row is the first of its rows
	 * written, as every writer of a principal's rows starts at it (`principalLockStatements`); nobody else sees it before
	 * the commit.
	 *
	 * The principal is inserted only while the invitation is open under this token, the checked authority holds
	 * (`checkedAuthority`: the inviter enabled, the schema revision unchanged, its assigning grant `FOR SHARE`) and the
	 * role is still external (`FOR SHARE`), so a refusal writes nothing. The acceptance repeats the authority and
	 * eligibility conditions, and a guard rolls the whole batch back if a change in between (the invitation cancelled or
	 * rotated) left the principal without its grant. A mailbox another writer claimed first fails the principal's unique
	 * mailbox, which rolls the batch back: `account_exists`.
	 */
	async acceptAsNewPrincipal(
		input: { readonly invitation: InvitationRow; readonly inviter: InviterCheck; readonly password: StoredPasswordHash },
		events: (principalId: string) => NewPrincipalEvents,
	): Promise<NewPrincipalAcceptance> {
		const { invitation, password } = input
		if (input.inviter.assigners.length === 0) {
			return { outcome: 'not_allowed' }
		}
		const now = unixNow()
		const principalId = uuidv7()
		const acceptanceId = uuidv7()
		const recorded = events(principalId)
		const authority = this.checkedAuthority(invitation, input.inviter, now)
		const inviter = authority.sql
		const inviterBinds = authority.binds
		const eligible = eligibleGrantBinds({ principalId, app: invitation.app, roleKey: invitation.role_key })
		const accepted = `EXISTS (SELECT 1 FROM membership_invitations WHERE id = ? AND acceptance_id = ?)`
		const create = this.writer.changed([{
			sql: `INSERT INTO principals (id, type, external_id, email, label, activated_at, created_at, affiliation)
				SELECT ?, 'user', NULL, ?, ?, ?, ?, 'external'
				WHERE EXISTS (
						SELECT 1 FROM membership_invitations
						WHERE id = ? AND token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?)
					AND ${inviter}
					AND EXISTS (SELECT 1 FROM roles WHERE app = ? AND role_key = ? AND external = 1 ${this.#shareLock})
				RETURNING id`,
			binds: [
				principalId,
				invitation.email,
				invitation.email,
				now,
				now,
				invitation.id,
				invitation.token_hash,
				now,
				...inviterBinds,
				invitation.app,
				invitation.role_key,
			],
		}], recorded.principal)
		const claim = this.db
			.prepare('INSERT INTO principal_email_claims (normalized_email, principal_id) SELECT email, id FROM principals WHERE id = ?')
			.bind(principalId)
		const accept = this.writer.changed([{
			sql: `UPDATE membership_invitations SET accepted_at = ?, accepted_by = ?, acceptance_id = ?
				WHERE id = ? AND token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
					AND EXISTS (SELECT 1 FROM principals WHERE id = ?)
					AND ${inviter}
					AND ${this.#eligible}
				RETURNING id`,
			binds: [now, principalId, acceptanceId, invitation.id, invitation.token_hash, now, principalId, ...inviterBinds, ...eligible],
		}], recorded.acceptance)
		const grant = this.db
			.prepare(`INSERT INTO grants (id, principal_id, app, role_key, permissions, scope_type, scope_value, granted_by, expires_at, created_at)
				SELECT ?, ?, ?, ?, NULL, ?, ?, ?, ?, ? WHERE ${accepted} AND ${this.#eligible}`)
			.bind(
				uuidv7(),
				principalId,
				invitation.app,
				invitation.role_key,
				invitation.scope_type,
				invitation.scope_value,
				invitation.invited_by,
				input.inviter.expiresAt,
				now,
				invitation.id,
				acceptanceId,
				...eligible,
			)
		const account = this.db
			.prepare(`INSERT INTO password_accounts (principal_id, state, created_at, updated_at) SELECT ?, 'enabled', ?, ? WHERE ${accepted}`)
			.bind(principalId, now, now, invitation.id, acceptanceId)
		const credential = this.writer.changed([{
			sql: `INSERT INTO password_credentials (principal_id, algorithm, parameters, salt, password_hash, created_at, updated_at)
				SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${accepted}
				RETURNING principal_id`,
			binds: [principalId, password.algorithm, password.parameters, password.salt, password.passwordHash, now, now, invitation.id, acceptanceId],
		}], recorded.password)
		// No principal without the grant it was created for: this NOT NULL violation rolls the batch back, principal included.
		const guard = this.db
			.prepare(`INSERT INTO contract_apps (app, created_at) SELECT ?, NULL
				WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?)
					AND NOT EXISTS (
						SELECT 1 FROM grants
						WHERE principal_id = ? AND app = ? AND role_key = ? AND scope_type = ? AND scope_value = ?)`)
			.bind(
				`${invitation.app}#principal-without-grant`,
				principalId,
				principalId,
				invitation.app,
				invitation.role_key,
				invitation.scope_type,
				invitation.scope_value,
			)
		const statements = [...authority.locks, ...create.statements, claim, ...accept.statements, grant, account, ...credential.statements, guard]
		let results: SqlQueryResult<{ id: string }>[]
		try {
			results = await this.db.batch<{ id: string }>(statements)
		} catch (cause) {
			if (await this.mailboxHeld(invitation.email)) return { outcome: 'account_exists' }
			const refused = await this.newPrincipalRefusal(invitation)
			if (refused !== null) return { outcome: refused }
			throw cause
		}
		if (accept.rows(results, authority.locks.length + create.statements.length + 1).length === 0) {
			if (await this.mailboxHeld(invitation.email)) return { outcome: 'account_exists' }
			return { outcome: (await this.newPrincipalRefusal(invitation)) ?? 'not_allowed' }
		}
		const principal = await this.db.prepare('SELECT * FROM principals WHERE id = ?').bind(principalId).first<PrincipalRow>()
		if (principal === null) {
			throw new Error('an accepted invitation created no principal')
		}
		return { outcome: 'accepted', principal }
	}

	/** Whether a user principal holds `mailbox`, a normalized address. */
	private async mailboxHeld(mailbox: string): Promise<boolean> {
		return (await this.db.prepare(`SELECT id FROM principals WHERE type = 'user' AND email = ?`).bind(mailbox).first()) !== null
	}

	/** Why an acceptance that would create its principal wrote nothing: the invitation closed, or its role is no longer external. */
	private async newPrincipalRefusal(invitation: InvitationRow): Promise<'not_open' | 'not_eligible' | null> {
		const current = await this.getInvitationById(invitation.id)
		const open = current !== null && current.token_hash === invitation.token_hash && current.accepted_at === null
			&& current.revoked_at === null && current.expires_at > unixNow()
		if (!open) return 'not_open'
		const external = await this.db
			.prepare('SELECT 1 AS external FROM roles WHERE app = ? AND role_key = ? AND external = 1')
			.bind(invitation.app, invitation.role_key)
			.first()
		return external === null ? 'not_eligible' : null
	}

	/**
	 * What an acceptance's writes require of the authority `inviter` checked: the inviter is still enabled and its grant
	 * revision unchanged (no grant of it was removed, the one that supplied an action of the role included), the app's
	 * schema revision is still the one read before the check, and the inviter still holds one of the assigners in the
	 * value, or an application-wide one globally (`ASSIGNING_GRANT`).
	 *
	 * On Postgres `locks` come first in the batch, in the principal-first order: the inviter's principal row `FOR SHARE`
	 * (a disable or a grant removal waits for the acceptance, or the acceptance reads the committed change), then the revision row
	 * `FOR SHARE` (a reconcile's increment, its first statement, waits, or the acceptance reads the new revision), and
	 * only then do the writes' conditions lock the assigning grant and the role row. SQLite and D1 run one writer at a
	 * time and need none.
	 */
	private checkedAuthority(
		invitation: InvitationRow,
		inviter: InviterCheck,
		now: number,
	): { readonly locks: SqlStatement[]; readonly sql: string; readonly binds: (string | number)[] } {
		const locks = this.#shareLock === ''
			? []
			: [
				this.db.prepare(`SELECT id FROM principals WHERE id = ? ${this.#shareLock}`).bind(invitation.invited_by),
				this.db.prepare(`SELECT revision FROM app_schema_revisions WHERE app = ? ${this.#shareLock}`).bind(invitation.app),
			]
		const sql = `EXISTS (SELECT 1 FROM principals WHERE id = ? AND disabled_at IS NULL AND grant_revision = ?)
			AND COALESCE((SELECT revision FROM app_schema_revisions WHERE app = ?), 0) = ?
			AND EXISTS (
				SELECT 1 FROM grants
				WHERE app = ? AND principal_id = ? AND ${ASSIGNING_GRANT} AND role_key IN (${inviter.assigners.map(() => '?').join(', ')})
					AND (expires_at IS NULL OR expires_at > ?)
				${this.#shareLock})`
		const binds = [
			invitation.invited_by,
			inviter.grantRevision,
			invitation.app,
			inviter.revision,
			invitation.app,
			invitation.invited_by,
			invitation.scope_type,
			invitation.scope_value,
			...inviter.assigners,
			now,
		]
		return { locks, sql, binds }
	}

	/** Whether `principalId` may not hold the invitation's role now (ADR-0051). */
	private async ineligible(invitation: InvitationRow, principalId: string): Promise<boolean> {
		const eligible = await this.db
			.prepare(`SELECT 1 AS eligible WHERE ${eligibleGrantSql('sqlite')}`)
			.bind(...eligibleGrantBinds({ principalId, app: invitation.app, roleKey: invitation.role_key }))
			.first()
		return eligible === null
	}

	/** Open, unexpired invitations to `scope`. */
	async listOpenInvitations(app: string, scope: Scope): Promise<InvitationRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM membership_invitations
				WHERE app = ? AND scope_type = ? AND scope_value = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
				ORDER BY id`)
			.bind(app, scope.type, scope.value, unixNow())
			.all<InvitationRow>()
		return results
	}

	/**
	 * Prune spent and expired delegation grants, and invitations whose expiry is older than
	 * `invitationCutoff` whatever their state (the audit log keeps the history). Returns rows removed.
	 */
	async prune(now: number, invitationCutoff: number): Promise<number> {
		const grants = await this.db
			.prepare('DELETE FROM delegation_grants WHERE expires_at <= ? OR consumed_at IS NOT NULL')
			.bind(now)
			.run()
		const invitations = await this.db.prepare('DELETE FROM membership_invitations WHERE expires_at < ?').bind(invitationCutoff).run()
		return grants.meta.changes + invitations.meta.changes
	}
}
