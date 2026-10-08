import type { CanonicalOperationsCatalogSourceV2, OperationsCatalogReconcileResponseV2 } from '@fabrika/operations-contract'
import { OPERATIONS_CATALOG_PROTOCOL_VERSION } from '@fabrika/operations-contract'
import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import type { SourceRow } from './sources.js'
import { number } from './values.js'

export interface CatalogCursorRow {
	revision: number
	snapshot_hash: string
	applied_at: number | string
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
		sources: CanonicalOperationsCatalogSourceV2[]
	}): Promise<OperationsCatalogReconcileResponseV2> {
		const cursor = await this.getCursor()
		if (input.revision < cursor.revision) return catalogResponse(cursor.revision, 'stale')
		if (input.revision === cursor.revision) {
			if (input.snapshotHash !== cursor.snapshot_hash) {
				throw new CatalogRevisionConflictError()
			}
			return catalogResponse(input.revision, 'unchanged', { unchanged: input.sources.length })
		}

		const before = await this.listControlSources()
		const beforeByCoordinate = new Map(before.map((source) => [sourceCoordinateKey(source.app_id, source.environment, source.service_key), source]))
		const statements = [
			this.db
				.prepare(`UPDATE sources SET
					enabled = 0,
					disabled_at = COALESCE(disabled_at, ?),
					updated_at = ?
				WHERE origin = 'control' AND enabled = 1
					AND (SELECT revision FROM operations_catalog_cursor WHERE singleton = 1) < ?
				RETURNING id`)
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
					WHERE (SELECT revision FROM operations_catalog_cursor WHERE singleton = 1) < ?
					RETURNING id`)
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
		const results = await this.db.batch<{ id?: string; revision?: number }>(statements)
		const cursorResult = results.at(-1)?.results[0]
		if (cursorResult?.revision !== input.revision) {
			const current = await this.getCursor()
			if (current.revision === input.revision && current.snapshot_hash !== input.snapshotHash) {
				throw new CatalogRevisionConflictError()
			}
			return catalogResponse(current.revision, current.revision === input.revision ? 'unchanged' : 'stale', {
				unchanged: current.revision === input.revision ? input.sources.length : 0,
			})
		}

		let created = 0
		let updated = 0
		let reenabled = 0
		let unchanged = 0
		for (const source of input.sources) {
			const key = sourceCoordinateKey(source.coordinate.appId, source.coordinate.environment, source.coordinate.serviceKey)
			const prior = beforeByCoordinate.get(key)
			if (!prior) {
				created++
			} else if (prior.enabled !== 1) {
				reenabled++
			} else if (prior.display_name !== source.displayName || prior.public_origin !== source.publicOrigin) {
				updated++
			} else {
				unchanged++
			}
		}
		const desiredSet = new Set(
			input.sources.map((source) => sourceCoordinateKey(source.coordinate.appId, source.coordinate.environment, source.coordinate.serviceKey)),
		)
		const disabled = before.filter((source) =>
			source.enabled === 1 && !desiredSet.has(
				sourceCoordinateKey(source.app_id, source.environment, source.service_key),
			)
		).length
		return catalogResponse(input.revision, 'applied', { created, updated, disabled, reenabled, unchanged })
	}
}

export class CatalogRevisionConflictError extends Error {
	constructor() {
		super('catalog revision was reused with different content')
	}
}

function sourceCoordinateKey(appId: string, environment: string, serviceKey: string): string {
	return JSON.stringify([appId, environment, serviceKey])
}

function catalogResponse(
	revision: number,
	outcome: OperationsCatalogReconcileResponseV2['outcome'],
	counts: Partial<Pick<OperationsCatalogReconcileResponseV2, 'created' | 'updated' | 'disabled' | 'reenabled' | 'unchanged'>> = {},
): OperationsCatalogReconcileResponseV2 {
	return {
		protocolVersion: OPERATIONS_CATALOG_PROTOCOL_VERSION,
		revision,
		outcome,
		created: counts.created ?? 0,
		updated: counts.updated ?? 0,
		disabled: counts.disabled ?? 0,
		reenabled: counts.reenabled ?? 0,
		unchanged: counts.unchanged ?? 0,
		ingest: [],
	}
}
