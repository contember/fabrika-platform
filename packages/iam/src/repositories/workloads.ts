import { parseJsonStringArray, type WorkloadKind } from '@fabrika/auth-core'
import { type SqlDatabase, type SqlStatement, uuidv7 } from '@fabrika/platform'
import { auditEventAboutStatement, type AuditEventInput } from './audit'
import type { PrincipalRow } from './principals'
import { unixNow } from './sql'

/** A workload's identity (the `workload_principals` table). */
export interface WorkloadPrincipalRow {
	principal_id: string
	app: string
	kind: WorkloadKind
	name: string
}

/**
 * One workload a schema reconcile declared (the `app_workloads` table). `actions` is a JSON array of exact actions;
 * `issues` the link mount a job may issue links of, or null.
 */
export interface AppWorkloadRow {
	app: string
	kind: WorkloadKind
	name: string
	actions: string
	issues: string | null
}

/** What the app's schema declares for one workload now. */
export interface WorkloadDeclaration {
	actions: string[]
	issues: string | null
}

/** A workload's principal is a `service` row under this external id, which the (type, external_id) index keeps unique. */
function workloadExternalId(app: string, kind: WorkloadKind, name: string): string {
	return `workload:${app}:${kind}:${name}`
}

/**
 * Workload principals and their declared actions (ADR-0022 "Principal kinds"). Issuing a key creates the principal;
 * the schema reconcile declares what it may do (`AppSchemaRepository.reconcileAppSchema` writes `app_workloads`).
 */
export class WorkloadRepository {
	constructor(protected readonly db: SqlDatabase) {}

	/**
	 * Issue one key of a workload in ONE transaction: the principal and its identity on first use, the revocation of every
	 * other live key except `keep`, the key, and `audit` about the principal. The principal is addressed by its external
	 * id throughout, and both identity inserts do nothing on a conflict, so two concurrent first issuances end with one
	 * principal that holds both keys' history. Answers the principal's id.
	 */
	async issueKey(
		input: {
			app: string
			kind: WorkloadKind
			name: string
			credentialId: string
			tokenHash: string
			issuedBy: string
			expiresAt: number
			keep: string | null
		},
		audit: AuditEventInput,
	): Promise<string> {
		const externalId = workloadExternalId(input.app, input.kind, input.name)
		const label = `${input.kind}:${input.name}`
		const now = unixNow()
		const principal = { sql: `SELECT id FROM principals WHERE type = 'service' AND external_id = ?`, binds: [externalId] }
		const statements: SqlStatement[] = [
			...this.identityStatements(input.app, input.kind, input.name, externalId, label, now),
			this.db
				.prepare(`UPDATE credentials SET revoked_at = ? WHERE principal_id = (${principal.sql}) AND revoked_at IS NULL AND id <> ?`)
				.bind(now, externalId, input.keep ?? ''),
			this.db
				.prepare(`INSERT INTO credentials (id, token_hash, label, principal_id, app, issued_by, expires_at, created_at)
					SELECT ?, ?, label, id, ?, ?, ?, ? FROM principals WHERE type = 'service' AND external_id = ?`)
				.bind(input.credentialId, input.tokenHash, input.app, input.issuedBy, input.expiresAt, now, externalId),
			auditEventAboutStatement(this.db, audit, principal),
		]
		await this.db.batch(statements)
		const principalId = await this.findPrincipalId(input.app, input.kind, input.name)
		if (principalId === null) throw new Error('a workload principal vanished after its key was issued')
		return principalId
	}

	/** The workload's principal, or null when no key was ever issued for it. */
	async findPrincipal(app: string, kind: WorkloadKind, name: string): Promise<PrincipalRow | null> {
		return this.db
			.prepare(`SELECT p.* FROM principals p JOIN workload_principals w ON w.principal_id = p.id
				WHERE w.app = ? AND w.kind = ? AND w.name = ?`)
			.bind(app, kind, name)
			.first<PrincipalRow>()
	}

	private identityStatements(app: string, kind: WorkloadKind, name: string, externalId: string, label: string, now: number): SqlStatement[] {
		return [
			this.db
				.prepare(`INSERT INTO principals (id, type, external_id, email, label, activated_at, created_at)
					VALUES (?, 'service', ?, NULL, ?, ?, ?) ON CONFLICT DO NOTHING`)
				.bind(uuidv7(), externalId, label, now, now),
			this.db
				.prepare(`INSERT INTO workload_principals (principal_id, app, kind, name)
					SELECT id, ?, ?, ? FROM principals WHERE type = 'service' AND external_id = ?
					ON CONFLICT DO NOTHING`)
				.bind(app, kind, name, externalId),
		]
	}

	/** The workload's principal id, or null when no key was ever issued for it. */
	async findPrincipalId(app: string, kind: WorkloadKind, name: string): Promise<string | null> {
		const row = await this.db
			.prepare('SELECT principal_id FROM workload_principals WHERE app = ? AND kind = ? AND name = ?')
			.bind(app, kind, name)
			.first<{ principal_id: string }>()
		return row?.principal_id ?? null
	}

	async getByPrincipal(principalId: string): Promise<WorkloadPrincipalRow | null> {
		return this.db.prepare('SELECT * FROM workload_principals WHERE principal_id = ?').bind(principalId).first<WorkloadPrincipalRow>()
	}

	/** The workload's declared actions, or null when the app's schema declares no such workload. */
	async declaredActions(app: string, kind: WorkloadKind, name: string): Promise<string[] | null> {
		return (await this.declaration(app, kind, name))?.actions ?? null
	}

	/** The workload's declaration, or null when the app's schema declares no such workload. */
	async declaration(app: string, kind: WorkloadKind, name: string): Promise<WorkloadDeclaration | null> {
		const row = await this.db
			.prepare('SELECT * FROM app_workloads WHERE app = ? AND kind = ? AND name = ?')
			.bind(app, kind, name)
			.first<AppWorkloadRow>()
		return row === null ? null : { actions: parseJsonStringArray(row.actions), issues: row.issues }
	}
}
