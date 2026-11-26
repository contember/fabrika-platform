// The approval policy an environment chose (ADR-0083 §2): a mode per category, stored as its difference from the
// defaults, so a category a later release adds applies to every environment that did not set it. The earlier list of
// waiting categories is written beside it, so a Control released before the policy reads the same choice.

import {
	type ActionMode,
	AGENT_WRITE_CATEGORY,
	APPROVAL_CATEGORIES,
	type ApprovalCategory,
	type ApprovalPolicy,
	approvalPolicySchema,
	type ApprovalSettings,
	approvalSettingsSchema,
	APPROVER_CATEGORIES,
	DEFAULT_APPROVAL_CATEGORIES,
	POLICY_CATEGORIES,
	policyFromCategories,
	STEP_UP_CATEGORIES,
	STRICT_POLICY,
	STRICT_SETTINGS,
	waitingCategories,
} from '@fabrika/control-contract'
import type { AgentWriteGate } from '@fabrika/iam-contract'
import { z } from 'zod'
import type { AppEnvRow } from '../db'

const storedChoice = z.object({
	added: z.array(z.enum(APPROVAL_CATEGORIES)),
	removed: z.array(z.enum(APPROVAL_CATEGORIES)),
}).strict()

/** Every category in `APPROVAL_CATEGORIES` order, once. */
function ordered(categories: Iterable<ApprovalCategory>): ApprovalCategory[] {
	const chosen = new Set(categories)
	return APPROVAL_CATEGORIES.filter((category) => chosen.has(category))
}

/** The categories an environment's row holds: the defaults, with what was added and without what was removed. */
export function appEnvCategories(row: Pick<AppEnvRow, 'approval_categories'>): ApprovalCategory[] {
	if (row.approval_categories === null) return [...DEFAULT_APPROVAL_CATEGORIES]
	const choice = storedChoice.parse(JSON.parse(row.approval_categories))
	const removed = new Set(choice.removed)
	return ordered([...DEFAULT_APPROVAL_CATEGORIES.filter((category) => !removed.has(category)), ...choice.added])
}

/** The stored form of a chosen list: null when it is the defaults. */
export function storedCategories(categories: readonly ApprovalCategory[]): string | null {
	const chosen = new Set(categories)
	const defaults = new Set(DEFAULT_APPROVAL_CATEGORIES)
	const added = ordered(categories).filter((category) => !defaults.has(category))
	const removed = DEFAULT_APPROVAL_CATEGORIES.filter((category) => !chosen.has(category))
	return added.length === 0 && removed.length === 0 ? null : JSON.stringify({ added, removed })
}

/** Whether a list is the defaults, which a stored classification leaves out so an older release still reads it. */
export function isDefaultCategories(categories: readonly ApprovalCategory[]): boolean {
	return storedCategories(categories) === null
}

/** Whether IAM holds the environment's console grants for approval: it is protected and `grants` waits for a person. */
export function grantsWait(row: Pick<AppEnvRow, 'protected' | 'approval_categories' | 'approval_policy'>): boolean {
	return row.protected === 1 && appEnvPolicy(row).grants === 'person'
}

/**
 * The environment's gates as IAM mirrors them (ADR-0083 §4, §8, ADR-0090 §5): its grant gate, `credentials`, and the
 * `agent-write` mode with its passkey; `off` and `open` when unprotected.
 */
export function iamGatesOf(row: Pick<AppEnvRow, 'protected' | 'approval_categories' | 'approval_policy' | 'approval_settings'>): IamGates {
	if (row.protected !== 1) return { grants: false, credentials: 'off', agentWrite: 'open' }
	const policy = appEnvPolicy(row)
	const agentWrite: AgentWriteGate = policy[AGENT_WRITE_CATEGORY] === 'refuse'
		? 'refuse'
		: appEnvSettings(row).stepUp[AGENT_WRITE_CATEGORY] === 'webauthn'
		? 'passkey'
		: 'open'
	return { grants: grantsWait(row), credentials: policy.credentials, agentWrite }
}

/**
 * What IAM holds of an environment's approval choice: whether its console grants wait, its `credentials` mode, and what
 * it does with an agent's `write` grant.
 */
export interface IamGates {
	readonly grants: boolean
	readonly credentials: ActionMode
	readonly agentWrite: AgentWriteGate
}

const CREDENTIALS_RANK: Readonly<Record<ActionMode, number>> = { off: 0, person: 1, refuse: 2 }

const AGENT_WRITE_RANK: Readonly<Record<AgentWriteGate, number>> = { open: 0, passkey: 1, refuse: 2 }

/** Each gate at the stricter of the two. */
export function stricterGates(a: IamGates, b: IamGates): IamGates {
	return {
		grants: a.grants || b.grants,
		credentials: CREDENTIALS_RANK[b.credentials] > CREDENTIALS_RANK[a.credentials] ? b.credentials : a.credentials,
		agentWrite: AGENT_WRITE_RANK[b.agentWrite] > AGENT_WRITE_RANK[a.agentWrite] ? b.agentWrite : a.agentWrite,
	}
}

/** Whether IAM holding `held` is looser than `sent`; IAM reads a gate it holds none of as `refuse`. */
export function looserAgentWrite(held: AgentWriteGate | null, sent: AgentWriteGate): boolean {
	return AGENT_WRITE_RANK[held ?? 'refuse'] < AGENT_WRITE_RANK[sent]
}

/** Whether IAM holding `held` is looser than `sent`; IAM reads a mode it holds none of as `person`. */
export function looserCredentials(held: ActionMode | null, sent: ActionMode): boolean {
	return CREDENTIALS_RANK[held ?? 'person'] < CREDENTIALS_RANK[sent]
}

export function sameGates(a: IamGates, b: IamGates): boolean {
	return a.grants === b.grants && a.credentials === b.credentials && a.agentWrite === b.agentWrite
}

/**
 * The modes a stored policy sets over the defaults, checked against the mode matrix; null when it holds a mode this
 * release does not take (a newer release's, after a rollback), which then reads as its waiting categories.
 */
function parseStoredPolicy(text: string): ApprovalPolicy | null {
	const parsed = approvalPolicySchema.partial().safeParse(JSON.parse(text))
	return parsed.success ? { ...STRICT_POLICY, ...parsed.data } : null
}

/**
 * The policy an environment's row holds (ADR-0083 §2). Null in both columns is the defaults, and a list alone (from
 * before the policy) is converted. A Control released before the policy writes only the list, so where the list's
 * waiting categories differ from the policy's, the list is newer: those categories take its conversion, and every other
 * mode keeps the policy's.
 */
export function appEnvPolicy(row: Pick<AppEnvRow, 'approval_categories' | 'approval_policy'>): ApprovalPolicy {
	const categories = appEnvCategories(row)
	const converted = row.approval_categories === null ? STRICT_POLICY : policyFromCategories(categories)
	const policy = row.approval_policy === null ? null : parseStoredPolicy(row.approval_policy)
	if (policy === null) return converted
	const waiting = new Set(categories)
	const changed = APPROVAL_CATEGORIES.filter((category) => (policy[category] !== 'off') !== waiting.has(category))
	if (changed.length === 0) return policy
	return approvalPolicySchema.parse({ ...policy, ...Object.fromEntries(changed.map((category) => [category, converted[category]])) })
}

/** The stored forms of a policy: the modes that differ from the defaults (null when none) and the earlier list. */
export function storedPolicy(policy: ApprovalPolicy): { readonly policy: string | null; readonly categories: string | null } {
	const changed = POLICY_CATEGORIES.filter((category) => policy[category] !== STRICT_POLICY[category])
	return {
		policy: changed.length === 0 ? null : JSON.stringify(Object.fromEntries(changed.map((category) => [category, policy[category]]))),
		categories: storedCategories(waitingCategories(policy)),
	}
}

const storedSettingsSchema = z.object({
	deployRequestCommits: approvalSettingsSchema.shape.deployRequestCommits.optional(),
	requestTtlHours: approvalSettingsSchema.shape.requestTtlHours.optional(),
	credentialCeiling: approvalSettingsSchema.shape.credentialCeiling.optional(),
	approvers: approvalSettingsSchema.shape.approvers.partial().optional(),
	requesterMayApprove: approvalSettingsSchema.shape.requesterMayApprove.partial().optional(),
	stepUp: approvalSettingsSchema.shape.stepUp.partial().optional(),
})

/**
 * The settings an environment's row holds (ADR-0083 §2): the defaults, with what it set over them. An unknown key (a
 * newer release's, after a rollback) is dropped, and a stored form this release cannot read reads as the defaults.
 */
export function appEnvSettings(row: Pick<AppEnvRow, 'approval_settings'>): ApprovalSettings {
	if (row.approval_settings === null) return STRICT_SETTINGS
	const parsed = storedSettingsSchema.safeParse(JSON.parse(row.approval_settings))
	if (!parsed.success) return STRICT_SETTINGS
	const stored = parsed.data
	return {
		deployRequestCommits: stored.deployRequestCommits ?? STRICT_SETTINGS.deployRequestCommits,
		requestTtlHours: stored.requestTtlHours ?? STRICT_SETTINGS.requestTtlHours,
		credentialCeiling: stored.credentialCeiling ?? STRICT_SETTINGS.credentialCeiling,
		approvers: { ...STRICT_SETTINGS.approvers, ...stored.approvers },
		requesterMayApprove: { ...STRICT_SETTINGS.requesterMayApprove, ...stored.requesterMayApprove },
		stepUp: { ...STRICT_SETTINGS.stepUp, ...stored.stepUp },
	}
}

/** The stored form of settings: what differs from the defaults, null when nothing does. */
export function storedSettings(settings: ApprovalSettings): { readonly settings: string | null } {
	const approvers = APPROVER_CATEGORIES.filter((category) => settings.approvers[category] !== STRICT_SETTINGS.approvers[category])
	const mayApprove = APPROVER_CATEGORIES.filter((category) => settings.requesterMayApprove[category] !== STRICT_SETTINGS.requesterMayApprove[category])
	const stepUp = STEP_UP_CATEGORIES.filter((category) => settings.stepUp[category] !== STRICT_SETTINGS.stepUp[category])
	const stored = {
		...(settings.deployRequestCommits === STRICT_SETTINGS.deployRequestCommits ? {} : { deployRequestCommits: settings.deployRequestCommits }),
		...(settings.requestTtlHours === STRICT_SETTINGS.requestTtlHours ? {} : { requestTtlHours: settings.requestTtlHours }),
		...(settings.credentialCeiling === STRICT_SETTINGS.credentialCeiling ? {} : { credentialCeiling: settings.credentialCeiling }),
		...(approvers.length === 0 ? {} : { approvers: Object.fromEntries(approvers.map((category) => [category, settings.approvers[category]])) }),
		...(mayApprove.length === 0
			? {}
			: { requesterMayApprove: Object.fromEntries(mayApprove.map((category) => [category, settings.requesterMayApprove[category]])) }),
		...(stepUp.length === 0 ? {} : { stepUp: Object.fromEntries(stepUp.map((category) => [category, settings.stepUp[category]])) }),
	}
	return { settings: Object.keys(stored).length === 0 ? null : JSON.stringify(stored) }
}
