// The approval categories an environment chose (ADR-0083): stored as their difference from the defaults, so a category a
// later release adds to the defaults applies to every environment that did not remove it by name.

import { APPROVAL_CATEGORIES, type ApprovalCategory, DEFAULT_APPROVAL_CATEGORIES } from '@fabrika/control-contract'
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

/** Whether IAM holds the environment's console grants for approval: it is protected and chose `grants`. */
export function grantsWait(row: Pick<AppEnvRow, 'protected' | 'approval_categories'>): boolean {
	return row.protected === 1 && appEnvCategories(row).includes('grants')
}
