import { isActionAllowed } from '@fabrika/auth-core'
import {
	type CursorList,
	type ListTerminalsInput,
	type OkResponse,
	type SetTerminalProfileRequest,
	type TerminalAsserterDto,
	type TerminalDto,
	type TerminalIdInput,
} from '@fabrika/iam-contract'
import { MAX_TERMINAL_SESSION_TTL_SECONDS, type TerminalAsserter, type TerminalRow } from '../db'
import { reachesCrossAppAuthority } from '../resolve'
import { terminalLabel } from '../terminals'
import { type AdminContext, adminEvent, fail } from './context'
import { knownApps } from './grant-support'
import { cursorOf, normalizeLimit } from './pagination'

function toTerminalDto(row: TerminalRow, asserters: readonly TerminalAsserter[]): TerminalDto {
	return {
		terminalId: row.principal_id,
		label: row.label,
		enrolledBy: row.enrolled_by,
		sessionTtl: row.session_ttl,
		asserters: asserters.map((asserter) => ({ app: asserter.app, ceiling: [...asserter.ceiling] })),
		status: row.revoked_at === null ? 'active' : 'revoked',
		createdAt: row.created_at,
		lastSeenAt: row.last_seen_at,
		revokedAt: row.revoked_at,
	}
}

/** One page of terminals, newest first, revoked ones included. Two queries: the page and its asserters. */
export async function listTerminalsUseCase(c: AdminContext, input: ListTerminalsInput): Promise<CursorList<TerminalDto>> {
	const limit = normalizeLimit(input.limit)
	const { terminals } = c.services.repositories
	const rows = await terminals.list({ ...(input.before ? { before: input.before } : {}), limit })
	const asserters = await terminals.listAssertersFor(rows.map((row) => row.principal_id))
	const items = rows.map((row) => toTerminalDto(row, asserters.get(row.principal_id) ?? []))
	return { items, nextCursor: cursorOf(items, limit, (item) => item.terminalId) }
}

/**
 * Replace an enrolled terminal's profile. An asserter is a registered application that is not a platform audience: a
 * platform audience's token carries cross-app authority, and IAM's own re-resolves the subject's permissions, either of
 * which would step past the ceiling. Each ceiling pattern must name actions of its application, as a typo check; the
 * ceiling only narrows what the person brings, so a pattern there grants nothing.
 */
export async function setTerminalProfileUseCase(c: AdminContext, input: SetTerminalProfileRequest): Promise<TerminalDto> {
	const label = terminalLabel(input.label)
	if (label === null) {
		return fail(400, 'label must be 1–100 characters without control characters')
	}
	if (!Number.isInteger(input.sessionTtl) || input.sessionTtl < 1 || input.sessionTtl > MAX_TERMINAL_SESSION_TTL_SECONDS) {
		return fail(400, `sessionTtl must be a whole number of seconds from 1 to ${MAX_TERMINAL_SESSION_TTL_SECONDS}`)
	}
	const asserters = await checkedAsserters(c, input.asserters)
	const { terminals } = c.services.repositories
	const changed = await terminals.setProfile(
		input.terminalId,
		{ label, sessionTtl: input.sessionTtl, asserters },
		adminEvent(c, {
			action: 'iam.terminal.profile.update',
			resourceType: 'terminal',
			resourceId: input.terminalId,
			metadata: { label, sessionTtl: input.sessionTtl, asserters },
		}),
	)
	const row = await terminals.getById(input.terminalId)
	if (row === null) {
		return fail(404, 'terminal not found')
	}
	if (!changed) {
		return fail(409, 'terminal is revoked')
	}
	return toTerminalDto(row, await terminals.listAsserters(input.terminalId))
}

async function checkedAsserters(c: AdminContext, requested: readonly TerminalAsserterDto[]): Promise<TerminalAsserter[]> {
	const registered = await knownApps(c)
	const seen = new Set<string>()
	const asserters: TerminalAsserter[] = []
	for (const { app, ceiling } of requested) {
		if (seen.has(app)) {
			return fail(400, `asserter listed twice: ${app}`)
		}
		seen.add(app)
		if (!registered.includes(app)) {
			return fail(400, `unknown app: ${app}`)
		}
		if (reachesCrossAppAuthority(c.services.config, app)) {
			return fail(400, `a platform audience cannot assert a person on a terminal: ${app}`)
		}
		const catalog = await c.services.repositories.appSchema.listActionCatalog(app)
		const unknown = ceiling.find((pattern) => !isActionAllowed(pattern, catalog))
		if (unknown !== undefined) {
			return fail(400, `unknown action pattern for ${app}: ${unknown}`)
		}
		asserters.push({ app, ceiling: [...new Set(ceiling)] })
	}
	return asserters
}

/** Revoke a terminal and every session issued on it. Repeating it answers the same; an unknown terminal is a 404. */
export async function revokeTerminalUseCase(c: AdminContext, input: TerminalIdInput): Promise<OkResponse> {
	const { terminals } = c.services.repositories
	const row = await terminals.getById(input.terminalId)
	if (row === null) {
		return fail(404, 'terminal not found')
	}
	await terminals.revoke(
		input.terminalId,
		adminEvent(c, { action: 'iam.terminal.revoke', resourceType: 'terminal', resourceId: input.terminalId, metadata: { label: row.label } }),
	)
	return { ok: true }
}
