import type { CanonicalOperationsCatalogSource, OperationsCatalogReconcileOutcome } from '@fabrika/operations-contract'
import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import type { SourceRow } from './sources.js'
import { number } from './values.js'

export interface CatalogCursorRow {
	revision: number
	snapshot_hash: string
	applied_at: number | string
}

export interface CatalogReconcileResult {
	revision: number
	outcome: OperationsCatalogReconcileOutcome
}

export class CatalogRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = Date.now) {}

	getCursor(): Promise<CatalogCursorRow> {
		return this.db
			.prepare('SELECT revision, snapshot_hash, applied_at FROM operations_catalog_cursor WHERE singleton = 1')
			.first<CatalogCursorRow>()
			.then((row) => {
				if (!row) throw new Error('operations catalog cursor is missing')
				return {
					revision: number(row.revision, 'operations_catalog_cursor.revision'),
					snapshot_hash: row.snapshot_hash,
					applied_at: number(row.applied_at, 'operations_catalog_cursor.applied_at'),
				}
			})
	}

	async listControlSources(): Promise<SourceRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM sources WHERE origin = 'control'
				ORDER BY app_id, environment, service_key`)
			.all<SourceRow>()
		return results
	}

	async reconcile(input: {
		revision: number
		snapshotHash: string
		sources: CanonicalOperationsCatalogSource[]
	}): Promise<CatalogReconcileResult> {
		const cursor = await this.getCursor()
		if (input.revision < cursor.revision) return { revision: cursor.revision, outcome: 'stale' }
		if (input.revision === cursor.revision) {
			if (input.snapshotHash !== cursor.snapshot_hash) {
				throw new CatalogRevisionConflictError()
			}
			return { revision: input.revision, outcome: 'unchanged' }
		}

		const statements = [
			this.db
				.prepare(`UPDATE sources SET
					enabled = 0,
					disabled_at = COALESCE(disabled_at, ?),
					updated_at = ?
				WHERE origin = 'control' AND enabled = 1
					AND (SELECT revision FROM operations_catalog_cursor WHERE singleton = 1) < ?`)
				.bind(this.now(), this.now(), input.revision),
			...input.sources.map((source) => {
				const id = uuidv7(this.now())
				return this.db
					.prepare(`INSERT INTO sources
					(id, app_id, environment, service_key, display_name, enabled, disabled_at, origin, public_origin, created_at, updated_at)
					SELECT ?, ?, ?, ?, ?, 1, NULL, 'control', ?, ?, ?
					WHERE (SELECT revision FROM operations_catalog_cursor WHERE singleton = 1) < ?
					ON CONFLICT (app_id, environment, service_key) DO UPDATE SET
						display_name = excluded.display_name,
						enabled = 1,
						disabled_at = NULL,
						public_origin = excluded.public_origin,
						updated_at = excluded.updated_at
					WHERE (SELECT revision FROM operations_catalog_cursor WHERE singleton = 1) < ?`)
					.bind(
						id,
						source.coordinate.appId,
						source.coordinate.environment,
						source.coordinate.serviceKey,
						source.displayName,
						source.publicOrigin,
						this.now(),
						this.now(),
						input.revision,
						input.revision,
					)
			}),
		]
		statements.push(
			this.db
				.prepare(`UPDATE operations_catalog_cursor SET revision = ?, snapshot_hash = ?, applied_at = ?
					WHERE singleton = 1 AND revision < ?
					RETURNING revision`)
				.bind(input.revision, input.snapshotHash, this.now(), input.revision),
		)
		const results = await this.db.batch<{ revision?: number }>(statements)
		const cursorResult = results.at(-1)?.results[0]
		if (cursorResult?.revision !== input.revision) {
			const current = await this.getCursor()
			if (current.revision === input.revision && current.snapshot_hash !== input.snapshotHash) {
				throw new CatalogRevisionConflictError()
			}
			return { revision: current.revision, outcome: current.revision === input.revision ? 'unchanged' : 'stale' }
		}
		return { revision: input.revision, outcome: 'applied' }
	}
}

export class CatalogRevisionConflictError extends Error {
	constructor() {
		super('catalog revision was reused with different content')
	}
}
