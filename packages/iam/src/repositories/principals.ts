import type { PrincipalAffiliation } from '@fabrika/auth-core'
import { type SqlDatabase, type SqlStatement, uuidv7 } from '@fabrika/platform'
import { normalizeEmailIdentity } from '../email-identity'
import { type AuditEventInput, auditEventStatement, AuditWriter, type SqlChange } from './audit'
import { firstRow, unixNow } from './sql'

export interface PrincipalRow {
	id: string
	type: 'user' | 'service'
	external_id: string | null
	/** THE NORMALIZED MAILBOX (`normalizeEmailIdentity`), never the display spelling — see `PrincipalRepository`. */
	email: string | null
	/** Display text: the mailbox as the IdP or the inviting admin spelled it. */
	label: string
	disabled_at: number | null
	activated_at: number | null
	created_at: number
	/** `external`: a person from outside the organization, who holds only roles declared external (ADR-0051). */
	affiliation: PrincipalAffiliation
}

/** Derived principal status — invited (not activated) → active → disabled. */
export type PrincipalStatus = 'invited' | 'active' | 'disabled'

export function principalStatus(row: PrincipalRow): PrincipalStatus {
	if (row.disabled_at !== null) {
		return 'disabled'
	}
	if (row.type === 'user' && row.activated_at === null) {
		return 'invited'
	}
	return 'active'
}

/**
 * IAM persistence capabilities over the `SqlDatabase` port — never a cloud-specific handle.
 * Portable operations use prepared statements via `db.prepare(...).bind(...)`; a runtime composition
 * root may replace one complete capability when its operation shape must differ by dialect.
 *
 * **ONE MAILBOX RULE.** `principals.email` holds the NORMALIZED mailbox and nothing else, so every
 * comparison is plain equality and no query asks the engine to case-fold (SQLite's `LOWER()` is
 * ASCII-only where Postgres's is full Unicode — the same input used to resolve differently per
 * backend). This class is the single place that applies `normalizeEmailIdentity`: callers hand over
 * whatever spelling they hold, the mailbox lands in `email` and the spelling in `label`.
 */
export class PrincipalRepository {
	constructor(
		protected readonly db: SqlDatabase,
		protected readonly writer: AuditWriter = new AuditWriter(db, 'sqlite'),
	) {}

	// ── Principals ──────────────────────────────────────────────────────────

	async getUserByExternalId(sub: string): Promise<PrincipalRow | null> {
		return this.db
			.prepare(`SELECT * FROM principals WHERE type = 'user' AND external_id = ?`)
			.bind(sub)
			.first<PrincipalRow>()
	}

	async getServiceByExternalId(commonName: string): Promise<PrincipalRow | null> {
		return this.db
			.prepare(`SELECT * FROM principals WHERE type = 'service' AND external_id = ?`)
			.bind(commonName)
			.first<PrincipalRow>()
	}

	async getPrincipalById(id: string): Promise<PrincipalRow | null> {
		return this.db.prepare('SELECT * FROM principals WHERE id = ?').bind(id).first<PrincipalRow>()
	}

	/** Resolve a user by mailbox. `email` is normalized here, so any spelling of it finds the same row. */
	async getUserByEmail(email: string): Promise<PrincipalRow | null> {
		return this.db
			.prepare(`SELECT * FROM principals WHERE type = 'user' AND email = ?`)
			.bind(normalizeEmailIdentity(email))
			.first<PrincipalRow>()
	}

	/**
	 * Refresh a returning user's mailbox/label if the token's email changed. No-op when unchanged.
	 *
	 * `IS DISTINCT FROM` is the null-safe `<>` — it must treat a NULL email as "different" so the
	 * first login of an invited row still fills it in. SQLite's `IS NOT <expr>` means the same
	 * thing but does not exist in Postgres (there `IS NOT` only takes NULL/TRUE/FALSE/UNKNOWN/
	 * DISTINCT FROM/DOCUMENT/JSON); `IS DISTINCT FROM` is standard and valid in both (SQLite ≥ 3.39).
	 *
	 * The reservation moves WITH the mailbox: leaving a stale claim behind would let the next invite
	 * of the new address create a second principal for the same human.
	 */
	async refreshUserLabel(id: string, email: string, audit?: AuditEventInput): Promise<void> {
		const mailbox = normalizeEmailIdentity(email)
		const refresh: SqlChange = {
			sql: 'UPDATE principals SET email = ?, label = ? WHERE id = ? AND (email IS DISTINCT FROM ? OR label IS DISTINCT FROM ?) RETURNING id',
			binds: [mailbox, email, id, mailbox, email],
		}
		await this.db.batch([...this.writer.changed([refresh], audit).statements, this.claimMailboxStatement(mailbox, id)])
	}

	/**
	 * Claim an invited row in one statement: bind `external_id = sub`, activate it, and set the
	 * display label, but only while still unclaimed (`external_id IS NULL`) to avoid a race claiming
	 * a row twice, and only an internal one: an IdP never claims an external principal (ADR-0051). The mailbox is untouched — it is what matched this row in the first place.
	 * Returns the claimed row, or null if the row was concurrently claimed / not found.
	 */
	async claimInvitedUser(id: string, sub: string, label: string, audit?: AuditEventInput): Promise<PrincipalRow | null> {
		const claim: SqlChange = {
			sql: `UPDATE principals SET external_id = ?, label = ?, activated_at = COALESCE(activated_at, ?)
				WHERE id = ? AND type = 'user' AND external_id IS NULL AND affiliation = 'internal'
				RETURNING *`,
			binds: [sub, label, unixNow(), id],
		}
		const [claimed] = await this.writer.run<PrincipalRow>([claim], audit)
		return claimed ?? null
	}

	/** Lazy-create a user keyed by the verified `sub`, reserving its mailbox and writing `audit` in the same transaction. */
	async createUser(sub: string, email: string, audit?: (principalId: string) => AuditEventInput): Promise<PrincipalRow> {
		const id = uuidv7()
		const now = unixNow()
		const mailbox = normalizeEmailIdentity(email)
		return this.insertUser([
			this.db
				.prepare(`INSERT INTO principals (id, type, external_id, email, label, activated_at, created_at)
					VALUES (?, 'user', ?, ?, ?, ?, ?) RETURNING *`)
				.bind(id, sub, mailbox, email, now, now),
			this.claimMailboxStatement(mailbox, id),
			...(audit === undefined ? [] : [auditEventStatement(this.db, audit(id))]),
		])
	}

	/**
	 * Invite a user by mailbox (external_id NULL = unclaimed), reserving it and writing `audit` in the same transaction.
	 * Only an installation administrator creates an `external` one; OIDC never claims it (ADR-0051).
	 */
	async inviteUser(
		email: string,
		label: string = email,
		audit?: (principalId: string) => AuditEventInput,
		affiliation: PrincipalAffiliation = 'internal',
	): Promise<PrincipalRow> {
		const id = uuidv7()
		const mailbox = normalizeEmailIdentity(email)
		return this.insertUser([
			this.db
				.prepare(`INSERT INTO principals (id, type, external_id, email, label, created_at, affiliation)
					VALUES (?, 'user', NULL, ?, ?, ?, ?) RETURNING *`)
				.bind(id, mailbox, label, unixNow(), affiliation),
			this.claimMailboxStatement(mailbox, id),
			...(audit === undefined ? [] : [auditEventStatement(this.db, audit(id))]),
		])
	}

	/**
	 * Reserve one mailbox for one principal. `principal_email_claims` is a second lock over the same
	 * rule `idx_principals_uq_email` enforces, and it moves with a principal whose address changes —
	 * every user row that carries a mailbox carries a claim for it.
	 */
	private claimMailboxStatement(mailbox: string, principalId: string): SqlStatement {
		return this.db
			.prepare(`INSERT INTO principal_email_claims (normalized_email, principal_id) VALUES (?, ?)
				ON CONFLICT (principal_id) DO UPDATE SET normalized_email = excluded.normalized_email`)
			.bind(mailbox, principalId)
	}

	/** Run a principal INSERT + its mailbox reservation as one transaction and return the new row. */
	private async insertUser(statements: SqlStatement[]): Promise<PrincipalRow> {
		const results = await this.db.batch<PrincipalRow>(statements)
		const principal = results[0]?.results[0]
		if (principal === undefined) throw new Error('expected a row from a RETURNING statement, got none')
		return principal
	}

	/**
	 * Create a native service (machine) principal. `external_id` is NULL — a native service is resolved
	 * through its `px_` credential (credential.principal_id → principal), never an external id. (The
	 * legacy CF service-token path still resolves existing services by their stored external_id.)
	 */
	async createService(label: string): Promise<PrincipalRow> {
		return firstRow<PrincipalRow>(this.createServiceStatement(uuidv7(), label))
	}

	/** The INSERT of a native service principal with a caller-generated id, for a batch that also writes its key. */
	createServiceStatement(id: string, label: string): SqlStatement {
		const now = unixNow()
		return this.db
			.prepare(`INSERT INTO principals (id, type, external_id, email, label, activated_at, created_at)
				VALUES (?, 'service', NULL, NULL, ?, ?, ?) RETURNING *`)
			.bind(id, label, now, now)
	}

	/**
	 * One page of principals, newest first.
	 *
	 * `status` is evaluated in SQL rather than by filtering a full table in memory. It is derived from
	 * exactly two columns (`disabled_at`, `activated_at` — see `principalStatus`), so expressing it
	 * here costs nothing and is what makes the page a real page: filtering after the read returned a
	 * short page from a long table and made `limit` mean nothing (SEC-22).
	 *
	 * Ordering is by `id DESC` alone. `created_at` is whole seconds, so rows written in the same second
	 * have no order of their own; the id is a monotonic UUIDv7, so it both orders and paginates
	 * (`before` is a keyset cursor that can neither skip nor repeat a row).
	 */
	async listPrincipals(filter: {
		type?: 'user' | 'service'
		status?: PrincipalStatus
		q?: string
		before?: string
		limit: number
		/** Leave out workload principals: a job's or a webhook's key is not an API key. */
		withoutWorkloads?: boolean
	}): Promise<PrincipalRow[]> {
		const where: string[] = []
		const binds: (string | number)[] = []
		if (filter.type) {
			where.push('type = ?')
			binds.push(filter.type)
		}
		if (filter.withoutWorkloads === true) {
			where.push('NOT EXISTS (SELECT 1 FROM workload_principals w WHERE w.principal_id = principals.id)')
		}
		if (filter.status === 'disabled') {
			where.push('disabled_at IS NOT NULL')
		} else if (filter.status === 'invited') {
			where.push(`disabled_at IS NULL AND type = 'user' AND activated_at IS NULL`)
		} else if (filter.status === 'active') {
			where.push(`disabled_at IS NULL AND (type <> 'user' OR activated_at IS NOT NULL)`)
		}
		if (filter.q) {
			// LOWER() on BOTH sides, deliberately: SQLite's LIKE case-folds ASCII, Postgres's does
			// not, so a bare `label LIKE ?` would silently stop matching 'Alice' for 'alice' after
			// the port. (`ILIKE` is Postgres-only, so it is not an option.)
			where.push('(LOWER(label) LIKE LOWER(?) OR LOWER(email) LIKE LOWER(?))')
			binds.push(`%${filter.q}%`, `%${filter.q}%`)
		}
		if (filter.before !== undefined) {
			where.push('id < ?')
			binds.push(filter.before)
		}
		binds.push(filter.limit)
		const sql = `SELECT * FROM principals${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
		const { results } = await this.db.prepare(sql).bind(...binds).all<PrincipalRow>()
		return results
	}

	/**
	 * The USER principals who can access `app` — every user holding at least one non-expired
	 * grant that applies to the app (the grant's `app` is NULL = cross-app, OR equals `app`).
	 * `DISTINCT` collapses the per-grant duplicates a principal with several grants produces.
	 * Services are excluded — this is the people directory (assignable users / actor labels),
	 * not machine principals. Disabled users ARE returned (the caller decides whether to hide
	 * them) so their labels still resolve. Ordered by label for a stable picker.
	 */
	async getPrincipalsForApp(app: string, options: { includeCrossApp: boolean }): Promise<PrincipalRow[]> {
		const appFilter = options.includeCrossApp ? '(g.app IS NULL OR g.app = ?)' : 'g.app = ?'
		const { results } = await this.db
			.prepare(`SELECT DISTINCT p.* FROM principals p
				JOIN grants g ON g.principal_id = p.id
				WHERE p.type = 'user'
					AND ${appFilter}
					AND (g.expires_at IS NULL OR g.expires_at > ?)
				ORDER BY p.label`)
			.bind(app, unixNow())
			.all<PrincipalRow>()
		return results
	}

	/** Disable a principal. Returns whether this call disabled it; `audit` is written only then. */
	disablePrincipal(id: string, audit?: AuditEventInput): Promise<boolean> {
		return this.guardedUpdate(this.disablePrincipalChange(id), audit)
	}

	/** The disabling of a principal, as a change an audited revocation groups with others. */
	disablePrincipalChange(id: string): SqlChange {
		return { sql: 'UPDATE principals SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL RETURNING id', binds: [unixNow(), id] }
	}

	/** Enable a principal. Returns whether this call enabled it; `audit` is written only then. */
	enablePrincipal(id: string, audit?: AuditEventInput): Promise<boolean> {
		return this.guardedUpdate(
			{ sql: 'UPDATE principals SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL RETURNING id', binds: [id] },
			audit,
		)
	}

	/**
	 * Make an external principal internal (ADR-0051), an installation administrator's operation. Returns whether this
	 * call changed it; `audit` is written only then. There is no way back: demotion is not an operation.
	 */
	promoteToInternal(id: string, audit?: AuditEventInput): Promise<boolean> {
		return this.guardedUpdate(
			{ sql: `UPDATE principals SET affiliation = 'internal' WHERE id = ? AND affiliation = 'external' RETURNING id`, binds: [id] },
			audit,
		)
	}

	private async guardedUpdate(update: SqlChange, audit: AuditEventInput | undefined): Promise<boolean> {
		return (await this.writer.run([update], audit)).length > 0
	}

	/** Hard-delete a principal (cancels an unclaimed invite; cascades grants). */
	async deletePrincipal(id: string): Promise<boolean> {
		const result = await this.db.prepare('DELETE FROM principals WHERE id = ?').bind(id).run()
		return (result.meta.changes ?? 0) > 0
	}
}
