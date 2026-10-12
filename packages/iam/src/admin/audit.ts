import { type AuditEventDto, type AuthLogDto, type ListAuditInput, type ListAuthLogInput } from '@fabrika/iam-contract'
import { type AuditEventRow, type AuthLogRow } from '../db'

import { parseJsonOrNull } from '../json'

import { type AdminContext } from './context'

import { normalizeLimit } from './pagination'

function toAuditEventDto(row: AuditEventRow): AuditEventDto {
	return {
		id: row.id,
		requestId: row.request_id,
		principalId: row.principal_id,
		principalLabel: row.principal_label,
		credentialId: row.credential_id,
		app: row.app,
		action: row.action,
		resourceType: row.resource_type,
		resourceId: row.resource_id,
		// Unparseable JSON reads as null rather than throwing — the DB no longer guarantees
		// validity (the `json_valid` CHECK was SQLite-only; see `parseJsonOrNull`).
		diff: row.diff === null ? null : parseJsonOrNull(row.diff),
		metadata: row.metadata === null ? null : parseJsonOrNull(row.metadata),
		createdAt: row.created_at,
	}
}

function toAuthLogDto(row: AuthLogRow): AuthLogDto {
	return {
		// The one backend-dependent column: a `number` on D1, a `string` on Postgres (a BIGINT identity,
		// which Bun decodes by column OID). Normalised HERE, once, so the DTO stays a plain number for
		// the SPA and for the `before=` cursor. Precision holds to 2^53 rows, far past any real auth log.
		id: typeof row.id === 'string' ? Number(row.id) : row.id,
		requestId: row.request_id,
		app: row.app,
		kind: row.kind,
		principalId: row.principal_id,
		credentialId: row.credential_id,
		decision: row.decision,
		reason: row.reason,
		privileged: row.privileged === 1,
		createdAt: row.created_at,
	}
}

export async function listAuditUseCase(c: AdminContext, input: ListAuditInput): Promise<{ items: AuditEventDto[]; nextCursor: string | null }> {
	const limit = normalizeLimit(input.limit)
	const rows = await c.services.repositories.audit.listAuditEvents({
		...(input.resourceType ? { resourceType: input.resourceType } : {}),
		...(input.resourceId ? { resourceId: input.resourceId } : {}),
		...(input.principalId ? { principalId: input.principalId } : {}),
		...(input.action ? { action: input.action } : {}),
		...(input.requestId ? { requestId: input.requestId } : {}),
		...(input.before ? { before: input.before } : {}),
		limit,
	})
	const items = rows.map(toAuditEventDto)
	const last = items.at(-1)
	const nextCursor = items.length === limit && last ? last.id : null
	return { items, nextCursor }
}

export async function listAuthLogUseCase(c: AdminContext, input: ListAuthLogInput): Promise<{ items: AuthLogDto[]; nextCursor: string | null }> {
	const limit = normalizeLimit(input.limit)
	const before = input.before ? Number.parseInt(input.before, 10) : undefined
	const rows = await c.services.repositories.audit.listAuthLog({
		...(input.principalId ? { principalId: input.principalId } : {}),
		...(input.requestId ? { requestId: input.requestId } : {}),
		...(input.decision ? { decision: input.decision } : {}),
		...(before !== undefined && Number.isFinite(before) ? { before } : {}),
		limit,
	})
	const items = rows.map(toAuthLogDto)
	const last = items.at(-1)
	const nextCursor = items.length === limit && last ? String(last.id) : null
	return { items, nextCursor }
}
