import { parseJsonStringArray, type WorkloadKind } from '@fabrika/auth-core'
import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import type { PrincipalRow } from './principals'
import { firstRow, unixNow } from './sql'

/** A workload's identity (the `workload_principals` table). */
export interface WorkloadPrincipalRow {
	principal_id: string
	app: string
	kind: WorkloadKind
	name: string
}

/** One workload a schema reconcile declared (the `app_workloads` table). `actions` is a JSON array of exact actions. */
export interface AppWorkloadRow {
	app: string
	kind: WorkloadKind
	name: string
	actions: string
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
	 * The workload's principal, created on first use. Both inserts do nothing on a conflict, so two concurrent callers
	 * end with one principal and one identity row, and both read it back.
	 */
	async ensurePrincipal(app: string, kind: WorkloadKind, name: string): Promise<PrincipalRow> {
		const externalId = workloadExternalId(app, kind, name)
		const now = unixNow()
		await this.db.batch([
			this.db
				.prepare(`INSERT INTO principals (id, type, external_id, email, label, activated_at, created_at)
					VALUES (?, 'service', ?, NULL, ?, ?, ?) ON CONFLICT DO NOTHING`)
				.bind(uuidv7(), externalId, `${kind}:${name}`, now, now),
			this.db
				.prepare(`INSERT INTO workload_principals (principal_id, app, kind, name)
					SELECT id, ?, ?, ? FROM principals WHERE type = 'service' AND external_id = ?
					ON CONFLICT DO NOTHING`)
				.bind(app, kind, name, externalId),
		])
		return firstRow<PrincipalRow>(
			this.db
				.prepare(`SELECT p.* FROM principals p JOIN workload_principals w ON w.principal_id = p.id
					WHERE w.app = ? AND w.kind = ? AND w.name = ?`)
				.bind(app, kind, name),
		)
	}

	async getByPrincipal(principalId: string): Promise<WorkloadPrincipalRow | null> {
		return this.db.prepare('SELECT * FROM workload_principals WHERE principal_id = ?').bind(principalId).first<WorkloadPrincipalRow>()
	}

	/** The workload's declared actions, or null when the app's schema declares no such workload. */
	async declaredActions(app: string, kind: WorkloadKind, name: string): Promise<string[] | null> {
		const row = await this.db
			.prepare('SELECT * FROM app_workloads WHERE app = ? AND kind = ? AND name = ?')
			.bind(app, kind, name)
			.first<AppWorkloadRow>()
		return row === null ? null : parseJsonStringArray(row.actions)
	}
}
