// The approval policy an environment chose (ADR-0083 §2): a mode per category, stored as its difference from the
// defaults, so a category a later release adds applies to every environment that did not set it. The earlier list of
// waiting categories is written beside it, so a Control released before the policy reads the same choice.

import {
	APPROVAL_CATEGORIES,
	type ApprovalCategory,
	type ApprovalPolicy,
	approvalPolicySchema,
	DEFAULT_APPROVAL_CATEGORIES,
	POLICY_CATEGORIES,
	policyFromCategories,
	STRICT_POLICY,
	waitingCategories,
} from '@fabrika/control-contract'
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
