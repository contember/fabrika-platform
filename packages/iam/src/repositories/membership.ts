import type { Scope } from '@fabrika/auth-core'
import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import type { GrantRow } from './grants'
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
}

/** One membership-role grant in a value, with the principal it belongs to. */
export interface MemberGrantRow {
	principal_id: string
	role_key: string
	label: string
	email: string | null
	disabled_at: number | null
}

/**
 * The rows behind the membership operations. Membership itself is ordinary role grants scoped to a value,
 * so a group assignment (backlog 91) can sit next to them later; this repository adds the values IAM
 * created, the single-use delegation grants and the invitations.
 */
/**
 * The conflict clause of every membership-role grant write. An ACTIVE grant of the role in the value is
 * kept as it is, which makes a repeated assignment answer the same result; an EXPIRED one is renewed in
 * the same statement, so it never reads as held while it grants nothing. Memberships do not expire.
 */
const RENEW_EXPIRED_MEMBERSHIP = `ON CONFLICT (principal_id, role_key, scope_type, scope_value, COALESCE(app, '*'))
	WHERE role_key IS NOT NULL AND scope_value IS NOT NULL
	DO UPDATE SET expires_at = NULL, granted_by = excluded.granted_by, created_at = excluded.created_at
	WHERE grants.expires_at IS NOT NULL AND grants.expires_at <= ?`

export class MembershipRepository {
	constructor(protected readonly db: SqlDatabase) {}

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

	/** Record a value IAM generated and grant its creator the creator role, in one transaction. */
	async createScope(input: { app: string; scope: Scope; createdBy: string; roleKey: string }): Promise<void> {
		const now = unixNow()
		await this.db.batch([
			this.db
				.prepare('INSERT INTO membership_scopes (app, scope_type, scope_value, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
				.bind(input.app, input.scope.type, input.scope.value, input.createdBy, now),
			this.db
				.prepare(`INSERT INTO grants (id, principal_id, app, role_key, permissions, scope_type, scope_value, granted_by, expires_at, created_at)
					VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?)`)
				.bind(uuidv7(), input.createdBy, input.app, input.roleKey, input.scope.type, input.scope.value, input.createdBy, now),
		])
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

	/** Every active grant of a membership role of `scope.type` in `scope`, with its principal. */
	async listMemberGrants(app: string, scope: Scope): Promise<MemberGrantRow[]> {
		const { results } = await this.db
			.prepare(`SELECT g.principal_id, g.role_key, p.label, p.email, p.disabled_at
				FROM grants g
				JOIN principals p ON p.id = g.principal_id
				JOIN roles r ON r.app = g.app AND r.role_key = g.role_key
				WHERE g.app = ? AND g.scope_type = ? AND g.scope_value = ? AND r.member_scope = ?
					AND (g.expires_at IS NULL OR g.expires_at > ?)
				ORDER BY g.principal_id, g.role_key`)
			.bind(app, scope.type, scope.value, scope.type, unixNow())
			.all<MemberGrantRow>()
		return results
	}

	/** Grant a membership role in `scope`. Returns the row when this call granted or renewed it, null when it was held. */
	async grantMembershipRole(input: { app: string; principalId: string; roleKey: string; scope: Scope; grantedBy: string }): Promise<GrantRow | null> {
		const now = unixNow()
		return this.db
			.prepare(`INSERT INTO grants (id, principal_id, app, role_key, permissions, scope_type, scope_value, granted_by, expires_at, created_at)
				VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?) ${RENEW_EXPIRED_MEMBERSHIP} RETURNING *`)
			.bind(uuidv7(), input.principalId, input.app, input.roleKey, input.scope.type, input.scope.value, input.grantedBy, now, now)
			.first<GrantRow>()
	}

	/** Remove one role grant of a principal in `scope`. Returns whether a row went. */
	async deleteRoleGrant(app: string, principalId: string, roleKey: string, scope: Scope): Promise<boolean> {
		const result = await this.db
			.prepare('DELETE FROM grants WHERE app = ? AND principal_id = ? AND role_key = ? AND scope_type = ? AND scope_value = ?')
			.bind(app, principalId, roleKey, scope.type, scope.value)
			.run()
		return result.meta.changes > 0
	}

	/**
	 * Remove a principal's creator-role grant in `scope` only while another principal still holds the role
	 * there. The value's `membership_scopes` row is the lock: created on demand, because an administrator
	 * may have granted the role without `createScope`, then taken with a row-locking UPDATE — the one lock
	 * statement SQLite and Postgres share; D1 runs a batch serially anyway. Two revokes of the last two
	 * holders therefore run one after the other, and the second sees the first's delete.
	 */
	async deleteCreatorGrantUnlessLast(app: string, principalId: string, roleKey: string, scope: Scope): Promise<boolean> {
		const now = unixNow()
		const [, , deleted] = await this.db.batch<{ id: string }>([
			this.db
				.prepare(`INSERT INTO membership_scopes (app, scope_type, scope_value, created_by, created_at) VALUES (?, ?, ?, NULL, ?)
					ON CONFLICT (app, scope_type, scope_value) DO NOTHING`)
				.bind(app, scope.type, scope.value, now),
			this.db
				.prepare('UPDATE membership_scopes SET created_at = created_at WHERE app = ? AND scope_type = ? AND scope_value = ?')
				.bind(app, scope.type, scope.value),
			this.db
				.prepare(`DELETE FROM grants
					WHERE app = ? AND principal_id = ? AND role_key = ? AND scope_type = ? AND scope_value = ?
						AND EXISTS (
							SELECT 1 FROM grants other
							WHERE other.app = ? AND other.role_key = ? AND other.scope_type = ? AND other.scope_value = ?
								AND other.principal_id <> ? AND (other.expires_at IS NULL OR other.expires_at > ?))
					RETURNING id`)
				.bind(app, principalId, roleKey, scope.type, scope.value, app, roleKey, scope.type, scope.value, principalId, now),
		])
		return (deleted?.results.length ?? 0) > 0
	}

	/**
	 * Open an invitation, or answer the open one for the same value, role and mailbox. An expired open
	 * invitation is closed first, so it never blocks a new one.
	 */
	async openInvitation(input: {
		tokenHash: string
		app: string
		scope: Scope
		roleKey: string
		email: string
		invitedBy: string
		expiresAt: number
	}): Promise<{ invitation: InvitationRow; created: boolean }> {
		const now = unixNow()
		const key = [input.app, input.scope.type, input.scope.value, input.roleKey, input.email]
		await this.db
			.prepare(`UPDATE membership_invitations SET revoked_at = ?
				WHERE app = ? AND scope_type = ? AND scope_value = ? AND role_key = ? AND email = ?
					AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= ?`)
			.bind(now, ...key, now)
			.run()
		const created = await this.db
			.prepare(`INSERT INTO membership_invitations
					(id, token_hash, app, scope_type, scope_value, role_key, email, invited_by, expires_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (app, scope_type, scope_value, role_key, email) WHERE accepted_at IS NULL AND revoked_at IS NULL DO NOTHING
				RETURNING *`)
			.bind(uuidv7(), input.tokenHash, ...key, input.invitedBy, input.expiresAt, now)
			.first<InvitationRow>()
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

	async getInvitationByHash(tokenHash: string): Promise<InvitationRow | null> {
		return this.db.prepare('SELECT * FROM membership_invitations WHERE token_hash = ?').bind(tokenHash).first<InvitationRow>()
	}

	async getInvitationById(id: string): Promise<InvitationRow | null> {
		return this.db.prepare('SELECT * FROM membership_invitations WHERE id = ?').bind(id).first<InvitationRow>()
	}

	/** Remove an invitation whose email could not be delivered, so a retry opens a fresh one. */
	async deleteInvitation(id: string): Promise<void> {
		await this.db.prepare('DELETE FROM membership_invitations WHERE id = ?').bind(id).run()
	}

	/** Close an open invitation. Answers whether it was still open. */
	async revokeInvitation(id: string): Promise<boolean> {
		const result = await this.db
			.prepare('UPDATE membership_invitations SET revoked_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL')
			.bind(unixNow(), id)
			.run()
		return result.meta.changes > 0
	}

	/**
	 * Accept an invitation for `principalId` and write its grant, in one transaction. The guarded UPDATE
	 * stamps a fresh acceptance id on the invitation only when it was still open, and the grant is written
	 * only for the attempt holding that id — never on the strength of a timestamp another attempt can share.
	 * An expired grant of the role is renewed; an active one is left as it is. Answers whether this call
	 * accepted the invitation.
	 */
	async acceptInvitation(invitation: InvitationRow, principalId: string): Promise<boolean> {
		const now = unixNow()
		const acceptanceId = uuidv7()
		const [accepted] = await this.db.batch<{ id: string }>([
			this.db
				.prepare(`UPDATE membership_invitations SET accepted_at = ?, accepted_by = ?, acceptance_id = ?
					WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
					RETURNING id`)
				.bind(now, principalId, acceptanceId, invitation.id, now),
			this.db
				.prepare(`INSERT INTO grants (id, principal_id, app, role_key, permissions, scope_type, scope_value, granted_by, expires_at, created_at)
					SELECT ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?
					WHERE EXISTS (SELECT 1 FROM membership_invitations WHERE id = ? AND acceptance_id = ?)
					${RENEW_EXPIRED_MEMBERSHIP}`)
				.bind(
					uuidv7(),
					principalId,
					invitation.app,
					invitation.role_key,
					invitation.scope_type,
					invitation.scope_value,
					invitation.invited_by,
					now,
					invitation.id,
					acceptanceId,
					now,
				),
		])
		return (accepted?.results.length ?? 0) > 0
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
