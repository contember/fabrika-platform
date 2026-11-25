// Approval requests (ADR-0083 §8): a non-person asks, holding the kind's right to ask on its own token; Control stores
// the request inert and exact and answers one console link; a person in the console with the approver's right decides
// it, and an approval executes at once with that person's authority, under the environment's deployment lease.

import type { AuthContext } from '@fabrika/auth'
import {
	ALL_ENVIRONMENTS,
	type ApprovalRequestChallengeInput,
	type ApprovalRequestDescription,
	type ApprovalRequestDto,
	type ApprovalRequestState,
	type ApprovalStepUpChallenge,
	CONTROL_ACTIONS,
	type CreateApprovalRequestResponse,
	type DecideApprovalRequestInput,
	type ListResponse,
} from '@fabrika/control-contract'
import type { IamAdministrationScope } from '@fabrika/iam-contract'
import { type DeployLocks, uuidv7 } from '@fabrika/platform'
import type { JsonValue } from '@fabrika/provider-contract'
import { fail } from '../../api/domain'
import type { ApprovalRequestDecider, ApprovalRequestRow, ControlRepositories } from '../../db'
import { jsonValueSchema } from '../../json-value'
import type { LeaseClock } from '../../lease'
import { type ConsoleAdmission, isConsolePerson, requireHumanApprover, requireOtherThanRequester } from '../human'
import { issueStepUpChallenge, type PasskeyStepUpPort, requestStepUpBinding, requireStepUp } from '../step-up'
import { acquireRequestLease, actionOf, discardRequest, executeApprovedRequest } from './execute'
import type { IamApprover } from './iam'
import type { RequestActionContext, RequestApprover, RequestCoordinates, RequestExecutionContext, RequestKind, RequestKindRegistry } from './kind'
import { PRODUCTION_REQUEST_KINDS } from './production'
import { refusedKindReason } from './refused'
import {
	decidersOf,
	holdsAtReach,
	holdsKindAction,
	jsonDigest,
	judging,
	mayExecute,
	reachOf,
	refusingEnvironment,
	type RequestDeciders,
	requesterOf,
	requestTtlHoursOf,
} from './rules'

export interface ApprovalRequestReadContext {
	readonly repositories: ControlRepositories
	readonly auth: AuthContext
	/** The console's public origin, for the request's link; a request cannot be created without it. */
	readonly consoleOrigin?: string
	/** The kinds served; the production registry when absent. */
	readonly kinds?: RequestKindRegistry
	/** IAM as the caller, with their console token: what they administer there, and the change an IAM kind makes. */
	readonly iamApprover?: IamApprover
}

/** Creating and deciding a request act through the registry's context: a kind seals, checks and executes there. */
export interface ApprovalRequestContext extends ApprovalRequestReadContext, RequestActionContext {
	/** The request the call arrived on: a person in the console is told apart from a bearer by it. */
	readonly admission: ConsoleAdmission
	/** Absent where Control holds no deployment lock: deciding is then unavailable. */
	readonly lock?: DeployLocks
	readonly leaseClock?: LeaseClock
	/** The approver's passkey step-up in IAM; absent, a decision that takes one is refused. */
	readonly stepUp?: PasskeyStepUpPort
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

const approvers = new WeakMap<ApprovalRequestReadContext, RequestApprover>()

/** The caller as a decider; IAM is asked what they administer at most once per call. */
function approverOf(c: ApprovalRequestReadContext): RequestApprover {
	const known = approvers.get(c)
	if (known !== undefined) return known
	let administration: Promise<IamAdministrationScope | null> | undefined
	const approver: RequestApprover = {
		auth: c.auth,
		iamAdministration: () => (administration ??= c.iamApprover?.administration() ?? Promise.resolve(null)),
	}
	approvers.set(c, approver)
	return approver
}

/**
 * Store a non-person's request for a person's approval (ADR-0083 §8). Refused: a person in the console (409: they act
 * directly), a kind no request may name (400, naming why), a kind this release does not route through a request (400),
 * an input its kind refuses (400), a requester whose own token lacks the kind's right to ask at the coordinates (404, as
 * an absent environment answers), and an action an environment it reaches refuses to a non-person (403). A secret value
 * is sealed under the request's own purpose before the row is written, and its fingerprint answered.
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
	if (kind === undefined) fail(400, `kind \`${body.kind}\` is not requestable yet: this release does not route it through an approval request`)
	const checked = kind.ask(body.input)
	if (!checked.ok) fail(400, `kind \`${body.kind}\`: ${checked.error}`)
	const asked = checked.asked
	const { appId, env } = asked.coordinates
	if (!holdsKindAction(c.auth, kind, asked.coordinates)) fail(404, env === ALL_ENVIRONMENTS ? 'app not found' : 'app env not found')
	const reach = await reachOf(c.repositories.registry, asked.coordinates)
	if (reach === null) fail(404, env === ALL_ENVIRONMENTS ? 'app not found' : 'app env not found')
	const refusing = refusingEnvironment(reach, kind.category)
	if (refusing !== null) {
		fail(
			403,
			`environment \`${refusing.env}\` refuses this to an agent or a key (${kind.category}: refuse): only a person makes the change, in the console`,
		)
	}
	if (c.consoleOrigin === undefined) fail(503, 'Control knows no console origin, so a request would have no link a person could open')
	const id = uuidv7()
	const held = await asked.hold(c, id)
	let row: ApprovalRequestRow
	try {
		const action = held.action
		const beforeJson = await action.captureBefore(c)
		row = await c.repositories.approvalRequests.create({
			id,
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
			ttlSeconds: requestTtlHoursOf(reach) * 3600,
		})
	} catch (cause) {
		await held.release().catch(() => console.warn(`approval request ${id}: kind ${kind.kind} could not release what it sealed`))
		throw cause
	}
	return {
		id: row.id,
		url: approvalRequestUrl(c.consoleOrigin, row.id),
		state: 'pending',
		...(held.fingerprint === undefined ? {} : { fingerprint: held.fingerprint }),
	}
}

/** One request: the requester's own, or any at coordinates where the caller may decide it. */
export async function getApprovalRequestUseCase(c: ApprovalRequestReadContext, id: string): Promise<ApprovalRequestDto> {
	const row = await c.repositories.approvalRequests.get(id)
	if (row === null || (!isRequester(c.auth, row) && !(await mayDecide(c, row)))) fail(404, 'approval request not found')
	return toApprovalRequestDto(c, row)
}

/**
 * Whether the caller is the request's requester: the same principal through the same OAuth client, or through no client
 * for a key. Another agent of the same person reads only what it asked for itself.
 */
function isRequester(auth: AuthContext, row: ApprovalRequestRow): boolean {
	return auth.principal !== null && row.requester_id === auth.principal.id && row.requester_client_id === (auth.oauth?.clientId ?? null)
}

/**
 * The requests waiting for a decision at coordinates where the caller may decide them, newest first. It pages through the
 * pending rows until the page is full, since the newest ones may all be where the caller decides nothing.
 */
export async function listApprovalRequestsUseCase(c: ApprovalRequestReadContext): Promise<ListResponse<ApprovalRequestDto>> {
	const rows: ApprovalRequestRow[] = []
	let beforeId: string | undefined
	while (rows.length < LIST_LIMIT) {
		const page = await c.repositories.approvalRequests.listPending(LIST_LIMIT, beforeId)
		for (const row of page) {
			if (rows.length < LIST_LIMIT && (await mayDecide(c, row))) rows.push(row)
		}
		const last = page.at(-1)
		if (page.length < LIST_LIMIT || last === undefined) break
		beforeId = last.id
	}
	return { items: await Promise.all(rows.map((row) => toApprovalRequestDto(c, row))) }
}

/** A request as a decision reads it: still pending, the one the page showed, before its deadline. */
interface PendingRequestDecision {
	readonly kind: 'pending'
	readonly approver: { readonly id: string; readonly label: string }
	readonly row: ApprovalRequestRow
	readonly deciders: RequestDeciders
}

/**
 * The checks every decision of a request passes first: a person in the console with the approver's right at its
 * coordinates, on the input digest the page showed, before the deadline. A request already decided answers its state.
 */
async function pendingRequestDecision(
	c: ApprovalRequestContext,
	input: ApprovalRequestChallengeInput,
): Promise<PendingRequestDecision | { readonly kind: 'decided'; readonly row: ApprovalRequestRow }> {
	const approver = requireHumanApprover(c.auth, c.admission)
	const row = await c.repositories.approvalRequests.get(input.id)
	if (row === null || !(await mayDecide(c, row))) fail(404, 'approval request not found')
	if (row.state !== 'pending') {
		if (row.decided_by_id === approver.id && decisionOf(row.state) === input.decision) return { kind: 'decided', row }
		if (row.state === 'expired') fail(410, expiredMessage(row))
		fail(409, `the request is ${row.state}, no longer waiting for a decision; reload it`)
	}
	if (row.input_digest !== input.inputDigest) fail(409, 'the request is not the one the page showed; reload it and decide again')
	if (row.deadline <= nowOf(c)) fail(410, expiredMessage(row))
	return { kind: 'pending', approver, row, deciders: await requestDeciders(c.repositories, row) }
}

/**
 * What an approval refuses before it is recorded or a passkey challenge is spent on it: a kind this Control cannot
 * execute, an approver who may not carry it out, and the requester's own person where barred.
 */
async function approvableKind(c: ApprovalRequestContext, pending: PendingRequestDecision): Promise<RequestKind> {
	const { row } = pending
	const kind = kindsOf(c).get(row.kind)
	// What the person saw is what executes: a request this Control cannot describe, it cannot approve either.
	if (kind === undefined || typeof actionOf(kind, row) === 'string') {
		fail(409, 'this Control cannot show what the request does, so it cannot approve it; refuse it or let it expire')
	}
	await requireApproverMayExecute(c, kind, row)
	if (!pending.deciders.requesterMayApprove) requireOtherThanRequester(pending.approver, requesterOf(row), 'request')
	return kind
}

/**
 * A single-use passkey challenge bound to one decision of a request whose deciding takes a step-up (ADR-0050 §5): the
 * same person, right and checks as the decision, so nobody is asked for a passkey for a decision Control refuses.
 */
export async function challengeApprovalRequestUseCase(
	c: ApprovalRequestContext,
	input: ApprovalRequestChallengeInput,
): Promise<ApprovalStepUpChallenge> {
	const pending = await pendingRequestDecision(c, input)
	if (pending.kind === 'decided') fail(409, `the request is ${pending.row.state}, no longer waiting for a decision; reload it`)
	if (pending.deciders.stepUp === 'none') fail(409, 'deciding this request takes no passkey')
	if (input.decision === 'approve') await approvableKind(c, pending)
	return await issueStepUpChallenge(c.stepUp, requestStepUpBinding(pending.row.id, input.decision, pending.row.input_digest))
}

/**
 * Approve or refuse one request: a person in the console with the approver's right at its coordinates, checked now,
 * posting the input digest the page showed. Every decision is one conditional write on `pending` before the deadline, so
 * a second tap or a repeated POST changes nothing. Under `approvers: 2` the first approval is partial and a different
 * person completes it; either may refuse. Under `requesterMayApprove: false` the requester's person may only refuse.
 * Under `stepUp: webauthn` either decision carries a passkey assertion bound to it, which IAM verifies before anything is
 * written (ADR-0050 §5). A completing approval executes at once, under the environment's deployment lease.
 */
export async function decideApprovalRequestUseCase(c: ApprovalRequestContext, input: DecideApprovalRequestInput): Promise<ApprovalRequestDto> {
	const pending = await pendingRequestDecision(c, input)
	if (pending.kind === 'decided') return toApprovalRequestDto(c, pending.row)
	const { approver, row, deciders } = pending
	const binding = requestStepUpBinding(row.id, input.decision, row.input_digest)

	if (input.decision === 'reject') {
		const stepUp = await requireStepUp(c.stepUp, deciders.stepUp, binding, approver, input.stepUp, 'decision')
		const decider = { decisionId: uuidv7(), id: approver.id, label: approver.label, stepUp }
		if (!(await c.repositories.approvalRequests.reject(row.id, decider))) await lostDecision(c, row.id)
		await auditDecision(c, row, 'reject', decider)
		await discardRequest(kindsOf(c).get(row.kind), c, row)
		return toApprovalRequestDto(c, await requireRow(c, row.id))
	}

	const kind = await approvableKind(c, pending)
	if (deciders.approvers === 2 && row.partial_approver_id === approver.id) return toApprovalRequestDto(c, row)
	const stepUp = await requireStepUp(c.stepUp, deciders.stepUp, binding, approver, input.stepUp, 'decision')
	const decider = { decisionId: uuidv7(), id: approver.id, label: approver.label, stepUp }
	if (deciders.approvers === 2 && row.partial_approver_id === null) {
		if (!(await c.repositories.approvalRequests.recordPartialApproval(row.id, decider))) await lostDecision(c, row.id)
		await auditDecision(c, row, 'approve', decider, true)
		return toApprovalRequestDto(c, await requireRow(c, row.id))
	}

	if (c.lock === undefined) fail(503, 'approvals unavailable')
	const lease = await acquireRequestLease(c.lock, c.repositories.registry, row, c.leaseClock)
	if (lease === null) fail(409, 'the environment, or one the request reaches, is deploying; nothing was decided, try again in a moment')
	try {
		if (!(await c.repositories.approvalRequests.approve(row.id, decider, row.partial_approver_id, lease.fence()))) await lostDecision(c, row.id)
		await auditDecision(c, row, 'approve', decider)
		await executeApprovedRequest(executionContext(c), kind, await requireRow(c, row.id), lease)
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

/** What an approved request executes through: the approver's own authority, from the console. */
function executionContext(c: ApprovalRequestContext): RequestExecutionContext {
	return {
		repositories: c.repositories,
		provider: c.provider,
		auth: c.auth,
		admission: c.admission,
		...(c.vault === undefined ? {} : { vault: c.vault }),
		...(c.catalogChanged === undefined ? {} : { catalogChanged: c.catalogChanged }),
		...(c.namespaceProxyChanged === undefined ? {} : { namespaceProxyChanged: c.namespaceProxyChanged }),
		...(c.iamGrants === undefined ? {} : { iamGrants: c.iamGrants }),
		...(c.iamApprover === undefined ? {} : { iamApprover: c.iamApprover }),
	}
}

/**
 * The approver's right at the request's coordinates: its kind's, or `access.approve` for Control's own kinds, at every
 * protected environment a request of `ALL_ENVIRONMENTS` reaches.
 */
async function mayDecide(c: ApprovalRequestReadContext, row: ApprovalRequestRow): Promise<boolean> {
	const coordinates: RequestCoordinates = { appId: row.app_id, env: row.env }
	const kind = kindsOf(c).get(row.kind)
	if (kind?.approverMayDecide !== undefined) return kind.approverMayDecide(approverOf(c), coordinates)
	return holdsAtReach(c.auth, c.repositories.registry, CONTROL_ACTIONS.ACCESS_APPROVE, coordinates)
}

/** An approval executes as the approver, so they hold the action itself where the request acts, as its route would ask. */
async function requireApproverMayExecute(c: ApprovalRequestReadContext, kind: RequestKind, row: ApprovalRequestRow): Promise<void> {
	if (!(await mayExecute(approverOf(c), kind, { appId: row.app_id, env: row.env }))) {
		fail(403, `approving carries the change out as you, and you do not hold \`${kind.requesterAction}\` where it acts; another person decides it`)
	}
}

async function requestDeciders(repositories: Pick<ControlRepositories, 'registry'>, row: ApprovalRequestRow): Promise<RequestDeciders> {
	return decidersOf((await reachOf(repositories.registry, { appId: row.app_id, env: row.env })) ?? [], row)
}

async function auditDecision(
	c: ApprovalRequestReadContext,
	row: ApprovalRequestRow,
	decision: 'approve' | 'reject',
	decider: ApprovalRequestDecider,
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
			...(partial ? { partial: true } : { decisionId: decider.decisionId }),
			...(decider.stepUp === null || decider.stepUp === undefined
				? {}
				: { stepUp: { credentialId: decider.stepUp.credentialId, at: decider.stepUp.at } }),
			inputDigest: row.input_digest,
			requester: {
				id: row.requester_id,
				label: row.requester_label,
				...(row.requester_client_id === null ? {} : { clientId: row.requester_client_id }),
			},
		},
	})
}

/**
 * What the page shows of a request whose kind this Control does not know or cannot read: its name, and its input to a
 * reader who holds the kind's right. The input may hold a value or a fingerprint; an unknown kind names no right.
 */
function undescribed(row: ApprovalRequestRow, full: boolean): ApprovalRequestDescription {
	return {
		summary: [{ text: `A change of kind ${row.kind}, which this Control cannot describe`, agent: false }],
		facts: full ? [{ label: 'Input', value: { text: row.input_json, agent: true } }] : [],
	}
}

/**
 * What the kind says the request does, or null when this Control cannot read the request well enough to say. A reader who
 * may not execute it is told what changes and that more is not shown to them.
 */
function describe(
	c: ApprovalRequestReadContext,
	row: ApprovalRequestRow,
	kind: RequestKind | undefined,
	full: boolean,
): ApprovalRequestDescription | null {
	let description: ApprovalRequestDescription
	try {
		const action = actionOf(kind, row)
		if (typeof action === 'string') return null
		description = action.describe(row.before_json, full)
	} catch {
		return null
	}
	if (full || kind === undefined) return description
	const hidden =
		`you do not hold \`${kind.requesterAction}\` where it acts, so what it acts on now, its value and any fingerprint are not shown to you; `
		+ 'you may refuse it, and approving it takes that right'
	return { ...description, facts: [...description.facts, { label: 'Not shown', value: { text: hidden, agent: false } }] }
}

/** Which environments a request of `ALL_ENVIRONMENTS` reaches now, and which of them are protected and judge it. */
async function reachFact(c: ApprovalRequestReadContext, row: ApprovalRequestRow): Promise<ApprovalRequestDescription['facts'][number]> {
	const reach = (await reachOf(c.repositories.registry, { appId: row.app_id, env: row.env })) ?? []
	const names = (envs: readonly { readonly env: string }[]) => envs.map((appEnv) => appEnv.env).join(', ')
	const protectedEnvs = judging(reach)
	const text = reach.length === 0
		? `every environment of ${row.app_id}; it has none yet`
		: `every environment of ${row.app_id}: ${names(reach)}; ${protectedEnvs.length === 0 ? 'none is protected' : `protected: ${names(protectedEnvs)}`}`
	return { label: 'Environments', value: { text, agent: false } }
}

function storedResult(text: string | null): JsonValue | undefined {
	if (text === null) return undefined
	const parsed = jsonValueSchema.safeParse(JSON.parse(text))
	return parsed.success ? parsed.data : undefined
}

export async function toApprovalRequestDto(c: ApprovalRequestReadContext, row: ApprovalRequestRow): Promise<ApprovalRequestDto> {
	const who = await requestDeciders(c.repositories, row)
	const kind = kindsOf(c).get(row.kind)
	const coordinates = { appId: row.app_id, env: row.env }
	// What the request acts on now, a value and a fingerprint are shown to one who may ask for it or carry it out; the
	// result repeats what it set.
	const full = kind !== undefined && (holdsKindAction(c.auth, kind, coordinates) || (await mayExecute(approverOf(c), kind, coordinates)))
	const result = full ? storedResult(row.result_json) : undefined
	const description = describe(c, row, kind, full)
	const reached = row.env === ALL_ENVIRONMENTS ? await reachFact(c, row) : null
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
		description: reached === null || description === null
			? (description ?? undescribed(row, full))
			: { ...description, facts: [...description.facts, reached] },
		described: description !== null,
		inputDigest: row.input_digest,
		approvers: who.approvers,
		requesterMayApprove: who.requesterMayApprove,
		stepUp: who.stepUp,
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
