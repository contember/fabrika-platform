// Approval requests (ADR-0083 §8): a non-person asks, holding the kind's right to ask on its own token; Control stores
// the request inert and exact and answers one console link; a person in the console with the approver's right decides
// it, and an approval executes at once with that person's authority, under the environment's deployment lease.

import type { AuthContext } from '@fabrika/auth'
import {
	type ApprovalRequestDescription,
	type ApprovalRequestDto,
	type ApprovalRequestState,
	CONTROL_ACTIONS,
	type CreateApprovalRequestResponse,
	type DecideApprovalRequestInput,
	gate,
	type ListResponse,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import { type DeployLocks, uuidv7 } from '@fabrika/platform'
import type { JsonValue } from '@fabrika/provider-contract'
import { fail } from '../../api/domain'
import { canAtCoordinates } from '../../api/runs'
import type { ApprovalRequestRow, ControlRepositories } from '../../db'
import { jsonValueSchema } from '../../json-value'
import { acquireLease, type LeaseClock, runLeaseKey } from '../../lease'
import { appEnvSettings } from '../categories'
import { type ConsoleAdmission, isConsolePerson, requireHumanApprover, requireOtherThanRequester } from '../human'
import { executeApprovedRequest } from './execute'
import { PRODUCTION_REQUEST_KINDS, type RequestCoordinates, type RequestKind, type RequestKindRegistry } from './kind'
import { refusedKindReason } from './refused'
import { deciders, jsonDigest, policyOf, requesterOf } from './rules'

export interface ApprovalRequestReadContext {
	readonly repositories: ControlRepositories
	readonly auth: AuthContext
	/** The console's public origin, for the request's link; a request cannot be created without it. */
	readonly consoleOrigin?: string
	/** The kinds served; the production registry when absent. */
	readonly kinds?: RequestKindRegistry
}

export interface ApprovalRequestContext extends ApprovalRequestReadContext {
	/** The request the call arrived on: a person in the console is told apart from a bearer by it. */
	readonly admission: ConsoleAdmission
	/** Absent where Control holds no deployment lock: deciding is then unavailable. */
	readonly lock?: DeployLocks
	readonly leaseClock?: LeaseClock
	/** Unix seconds; the repositories' own clock in a test. */
	readonly now?: () => number
}

const LIST_LIMIT = 100

/** The link a person decides a request at; a parked run keeps `<console>/approvals/<run id>`. */
export function approvalRequestUrl(consoleOrigin: string, id: string): string {
	return `${consoleOrigin}/approvals/requests/${encodeURIComponent(id)}`
}

function nowOf(c: ApprovalRequestContext): number {
	return (c.now ?? (() => Math.floor(Date.now() / 1000)))()
}

function kindsOf(c: ApprovalRequestReadContext): RequestKindRegistry {
	return c.kinds ?? PRODUCTION_REQUEST_KINDS
}

/**
 * Store a non-person's request for a person's approval (ADR-0083 §8). Refused: a person in the console (409: they act
 * directly), a kind no request may name (400, naming why), a kind this release does not route through a request (400),
 * an input its kind refuses (400), a requester whose own token lacks the kind's right to ask at the coordinates (404, as
 * an absent environment answers), and an action the environment refuses to a non-person (403).
 */
export async function createApprovalRequestUseCase(
	c: ApprovalRequestContext,
	body: { readonly kind: string; readonly input: JsonValue },
): Promise<CreateApprovalRequestResponse> {
	const principal = c.auth.principal
	if (principal === null) fail(403, 'an anonymous caller cannot ask for an approval')
	if (isConsolePerson(c.auth, c.admission)) {
		fail(409, 'a person signed in to the console makes the change directly; an approval request is how an agent or a key asks a person')
	}
	const refused = refusedKindReason(body.kind)
	if (refused !== null) fail(400, `kind \`${body.kind}\` can never be requested: ${refused}`)
	const kind = kindsOf(c).get(body.kind)
	if (kind === undefined) fail(400, `kind \`${body.kind}\` is not requestable yet: no change goes through an approval request in this release`)
	const checked = kind.action(body.input)
	if (!checked.ok) fail(400, `kind \`${body.kind}\`: ${checked.error}`)
	const action = checked.action
	const { appId, env } = action.coordinates
	if (!canAtCoordinates(c.auth, kind.requesterAction, appId, env)) fail(404, 'app env not found')
	const appEnv = await c.repositories.registry.getAppEnv(appId, env)
	if (appEnv === null) fail(404, 'app env not found')
	if (gate({ lines: [], actions: [kind.category] }, policyOf(appEnv)).kind === 'refuse') {
		fail(
			403,
			`environment \`${env}\` refuses this to an agent or a key (${kind.category}: refuse): only a person makes the change, in the console`,
		)
	}
	if (c.consoleOrigin === undefined) fail(503, 'Control knows no console origin, so a request would have no link a person could open')
	const beforeJson = await action.captureBefore(c)
	const row = await c.repositories.approvalRequests.create({
		id: uuidv7(),
		kind: kind.kind,
		inputJson: action.inputJson,
		inputDigest: jsonDigest(action.inputJson),
		appId,
		env,
		category: kind.category,
		requester: {
			id: principal.id,
			type: principal.type,
			label: principal.label,
			credential: c.auth.oauth === undefined ? 'key' : 'oauth',
			clientId: c.auth.oauth?.clientId ?? null,
			grantId: c.auth.oauth?.grantId ?? null,
			// The verified token names no issuer of the key it was minted from; a later auth context that does fills it.
			issuerId: null,
		},
		beforeJson,
		beforeDigest: jsonDigest(beforeJson),
		ttlSeconds: appEnvSettings(appEnv).requestTtlHours * 3600,
	})
	return { id: row.id, url: approvalRequestUrl(c.consoleOrigin, row.id), state: 'pending' }
}

/** One request: the requester's own, or any at coordinates where the caller may decide it. */
export async function getApprovalRequestUseCase(c: ApprovalRequestReadContext, id: string): Promise<ApprovalRequestDto> {
	const row = await c.repositories.approvalRequests.get(id)
	if (row === null || (row.requester_id !== c.auth.principal?.id && !mayDecide(c, row))) fail(404, 'approval request not found')
	return toApprovalRequestDto(c, row)
}

/** The requests waiting for a decision at coordinates where the caller may decide them, newest first. */
export async function listApprovalRequestsUseCase(c: ApprovalRequestReadContext): Promise<ListResponse<ApprovalRequestDto>> {
	const rows = await c.repositories.approvalRequests.listPending(LIST_LIMIT)
	return { items: await Promise.all(rows.filter((row) => mayDecide(c, row)).map((row) => toApprovalRequestDto(c, row))) }
}

/**
 * Approve or refuse one request: a person in the console with the approver's right at its coordinates, checked now,
 * posting the input digest the page showed. Every decision is one conditional write on `pending` before the deadline, so
 * a second tap or a repeated POST changes nothing. Under `approvers: 2` the first approval is partial and a different
 * person completes it; either may refuse. Under `requesterMayApprove: false` the requester's person may only refuse. A
 * completing approval executes at once, under the environment's deployment lease.
 */
export async function decideApprovalRequestUseCase(c: ApprovalRequestContext, input: DecideApprovalRequestInput): Promise<ApprovalRequestDto> {
	const approver = requireHumanApprover(c.auth, c.admission)
	const row = await c.repositories.approvalRequests.get(input.id)
	if (row === null || !mayDecide(c, row)) fail(404, 'approval request not found')
	if (row.state !== 'pending') {
		if (row.decided_by_id === approver.id && decisionOf(row.state) === input.decision) return toApprovalRequestDto(c, row)
		if (row.state === 'expired') fail(410, expiredMessage(row))
		fail(409, `the request is ${row.state}, no longer waiting for a decision; reload it`)
	}
	if (row.input_digest !== input.inputDigest) fail(409, 'the request is not the one the page showed; reload it and decide again')
	if (row.deadline <= nowOf(c)) fail(410, expiredMessage(row))
	const deciders = await requestDeciders(c.repositories, row)
	const decider = { decisionId: uuidv7(), id: approver.id, label: approver.label }

	if (input.decision === 'reject') {
		if (!(await c.repositories.approvalRequests.reject(row.id, decider))) await lostDecision(c, row.id)
		await auditDecision(c, row, 'reject', decider.decisionId)
		return toApprovalRequestDto(c, await requireRow(c, row.id))
	}

	const kind = kindsOf(c).get(row.kind)
	if (kind === undefined) fail(409, `this Control cannot execute kind \`${row.kind}\`, so it cannot approve the request; refuse it or let it expire`)
	if (!deciders.requesterMayApprove) requireOtherThanRequester(approver, requesterOf(row), 'request')
	if (deciders.approvers === 2) {
		if (row.partial_approver_id === approver.id) return toApprovalRequestDto(c, row)
		if (row.partial_approver_id === null) {
			if (!(await c.repositories.approvalRequests.recordPartialApproval(row.id, approver))) await lostDecision(c, row.id)
			await auditDecision(c, row, 'approve', decider.decisionId, true)
			return toApprovalRequestDto(c, await requireRow(c, row.id))
		}
	}

	if (c.lock === undefined) fail(503, 'approvals unavailable')
	const lease = await acquireLease(c.lock, runLeaseKey(row.app_id, row.env), c.leaseClock)
	if (lease === null) fail(409, 'the environment is deploying; nothing was decided, try again in a moment')
	try {
		if (!(await c.repositories.approvalRequests.approve(row.id, decider, row.partial_approver_id, lease.fence()))) await lostDecision(c, row.id)
		await auditDecision(c, row, 'approve', decider.decisionId)
		await executeApprovedRequest({ repositories: c.repositories, auth: c.auth }, kind, await requireRow(c, row.id), lease)
	} finally {
		await lease.release()
	}
	return toApprovalRequestDto(c, await requireRow(c, row.id))
}

/** The decision a decided state records. */
function decisionOf(state: ApprovalRequestState): 'approve' | 'reject' | null {
	if (state === 'rejected') return 'reject'
	if (state === 'pending' || state === 'expired') return null
	return 'approve'
}

/** A conditional decision changed nothing: past the deadline it is gone (410), else another decision landed first. */
async function lostDecision(c: ApprovalRequestContext, id: string): Promise<never> {
	const latest = await c.repositories.approvalRequests.get(id)
	const now = nowOf(c)
	if (latest !== null && (latest.state === 'expired' || (latest.state === 'pending' && latest.deadline <= now))) fail(410, expiredMessage(latest))
	fail(409, 'another decision landed first, or the request is no longer waiting; reload it')
}

function expiredMessage(row: Pick<ApprovalRequestRow, 'deadline'>): string {
	return `nobody decided this request before its deadline, ${new Date(row.deadline * 1000).toISOString()}, so it expired and changes nothing; `
		+ 'the agent asks again'
}

async function requireRow(c: ApprovalRequestReadContext, id: string): Promise<ApprovalRequestRow> {
	return (await c.repositories.approvalRequests.get(id)) ?? fail(404, 'approval request not found')
}

/** The approver's right at the request's coordinates: its kind's, or `access.approve` for Control's own kinds. */
function mayDecide(c: ApprovalRequestReadContext, row: ApprovalRequestRow): boolean {
	const coordinates: RequestCoordinates = { appId: row.app_id, env: row.env }
	const kind = kindsOf(c).get(row.kind)
	if (kind?.approverMayDecide !== undefined) return kind.approverMayDecide(c.auth, coordinates)
	return canAtCoordinates(c.auth, CONTROL_ACTIONS.ACCESS_APPROVE, row.app_id, row.env)
}

async function requestDeciders(
	repositories: Pick<ControlRepositories, 'registry'>,
	row: ApprovalRequestRow,
): Promise<{ approvers: 1 | 2; requesterMayApprove: boolean }> {
	const appEnv = await repositories.registry.getAppEnv(row.app_id, row.env)
	return deciders(appEnv === null ? STRICT_SETTINGS : appEnvSettings(appEnv), row)
}

async function auditDecision(
	c: ApprovalRequestReadContext,
	row: ApprovalRequestRow,
	decision: 'approve' | 'reject',
	decisionId: string,
	partial = false,
): Promise<void> {
	await c.auth.audit({
		action: CONTROL_ACTIONS.ACCESS_APPROVE,
		resourceType: 'approval_request',
		resourceId: row.id,
		metadata: {
			appId: row.app_id,
			env: row.env,
			kind: row.kind,
			category: row.category,
			decision,
			...(partial ? { partial: true } : { decisionId }),
			inputDigest: row.input_digest,
			requester: {
				id: row.requester_id,
				label: row.requester_label,
				...(row.requester_client_id === null ? {} : { clientId: row.requester_client_id }),
			},
		},
	})
}

/** What the page shows of a request whose kind this Control does not know or cannot read: its name and its input. */
function undescribed(row: ApprovalRequestRow): ApprovalRequestDescription {
	return {
		summary: [{ text: `A change of kind ${row.kind}, which this Control cannot describe`, agent: false }],
		facts: [{ label: 'Input', value: { text: row.input_json, agent: true } }],
	}
}

function describe(c: ApprovalRequestReadContext, row: ApprovalRequestRow): ApprovalRequestDescription {
	const kind: RequestKind | undefined = kindsOf(c).get(row.kind)
	if (kind === undefined) return undescribed(row)
	try {
		const checked = kind.action(JSON.parse(row.input_json))
		return checked.ok ? checked.action.describe(row.before_json) : undescribed(row)
	} catch {
		return undescribed(row)
	}
}

function storedResult(text: string | null): JsonValue | undefined {
	if (text === null) return undefined
	const parsed = jsonValueSchema.safeParse(JSON.parse(text))
	return parsed.success ? parsed.data : undefined
}

export async function toApprovalRequestDto(c: ApprovalRequestReadContext, row: ApprovalRequestRow): Promise<ApprovalRequestDto> {
	const who = await requestDeciders(c.repositories, row)
	const result = storedResult(row.result_json)
	return {
		id: row.id,
		kind: row.kind,
		category: row.category,
		appId: row.app_id,
		env: row.env,
		state: row.state,
		...(c.consoleOrigin === undefined ? {} : { url: approvalRequestUrl(c.consoleOrigin, row.id) }),
		requester: {
			principal: { id: row.requester_id, type: row.requester_type, label: row.requester_label },
			credential: row.requester_credential,
			...(row.requester_client_id === null ? {} : { clientId: row.requester_client_id }),
			...(row.requester_grant_id === null ? {} : { grantId: row.requester_grant_id }),
			...(row.requester_issuer_id === null ? {} : { issuerId: row.requester_issuer_id }),
			personId: requesterOf(row).personId,
		},
		description: describe(c, row),
		inputDigest: row.input_digest,
		approvers: who.approvers,
		requesterMayApprove: who.requesterMayApprove,
		...(row.state === 'pending' && row.partial_approver_id !== null && row.partial_approver_label !== null && row.partial_approved_at !== null
			? { partialApproval: { principalId: row.partial_approver_id, label: row.partial_approver_label, at: row.partial_approved_at } }
			: {}),
		...(row.decided_by_id !== null && row.decided_by_label !== null && row.decided_at !== null
			? { decision: { principalId: row.decided_by_id, label: row.decided_by_label, at: row.decided_at } }
			: {}),
		deadline: row.deadline,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.operation_id === null ? {} : { operationId: row.operation_id }),
		...(result === undefined ? {} : { result }),
		...(row.error === null ? {} : { error: row.error }),
	}
}
