// What lets a change through on a protected environment (ADR-0083 §1–§2): a mode per category, and one gate that
// judges a deploy's lines and a non-person's action against it. Control's deploy gate, the request path and the
// console all call `gate`; nothing else decides whether a change waits.

import { z } from 'zod'
import type { AccessChangeDto } from './index.js'

/**
 * Why a line needs closer review: a step off the paved road, something anyone without signing in sets off, a mutation
 * served on `GET`, people becoming visible, a file collection adopted or released, the application naming who signs
 * in at an enrolled terminal, or a migration statement not known to keep every stored value.
 */
export const REVIEW_REASONS = ['off-road', 'anyone-calls', 'get-mutation', 'people', 'adoption', 'terminal', 'deletes-data'] as const

export type ReviewReason = (typeof REVIEW_REASONS)[number]

/**
 * The kinds of change an environment may make wait for a person (ADR-0083): each closer-review reason, the permission
 * changes in the contract (`role-actions`, `role-external`, `role-added`), an endpoint anyone opens (`public`), a CSP
 * origin (`csp`), and a console grant, grant edit or revocation in IAM (`grants`). `changeCategories` places a line.
 */
export const APPROVAL_CATEGORIES = [...REVIEW_REASONS, 'role-actions', 'role-external', 'role-added', 'public', 'csp', 'grants'] as const

export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number]

/** What a protected environment waits for when nobody chose otherwise: ADR-0050's closer-review reasons, nothing more. */
export const DEFAULT_APPROVAL_CATEGORIES: readonly ApprovalCategory[] = REVIEW_REASONS

/** The fields of a line that place it in a category. */
export type CategorizedChange = Pick<AccessChangeDto, 'effect' | 'review' | 'reason' | 'rule' | 'audience'>

/**
 * The approval categories a line belongs to (ADR-0083 §1). A closer-review line belongs to its reason; one stored before
 * lines carried a reason belongs to every reason, so it waits whenever any of them is chosen. The permission, public and
 * CSP categories take a line by its rule, and only when it widens, except a new role. `grants` holds no deploy line.
 */
export function changeCategories(change: CategorizedChange): ApprovalCategory[] {
	const categories: ApprovalCategory[] = []
	if (change.review === 'closer') categories.push(...(change.reason === undefined ? REVIEW_REASONS : [change.reason]))
	if (change.rule === 'role.added') categories.push('role-added')
	if (change.effect !== 'widens') return categories
	switch (change.rule) {
		case 'role.grants':
		case 'role.via':
			categories.push('role-actions')
			break
		case 'role.external':
			categories.push('role-external')
			break
		case 'endpoint.public':
			categories.push('public')
			break
		case 'endpoint.added':
			if (change.audience?.reach === 'anyone') categories.push('public')
			break
		case 'csp.source':
			categories.push('csp')
			break
	}
	return categories
}

/** What lets a change of a category through, ordered from the least to the most strict. */
export const APPROVAL_MODES = ['off', 'plan', 'person', 'refuse'] as const

export type ApprovalMode = (typeof APPROVAL_MODES)[number]

/**
 * The actions of a non-person that no deploy line describes (ADR-0083 §1): a manual run it starts, a secret, variable,
 * data or registry write, a grant or a key it asks for.
 */
export const ACTION_CATEGORIES = ['deploy-request', 'secrets', 'variables', 'data', 'registry', 'agent-grants', 'credentials'] as const

export type ActionCategory = (typeof ACTION_CATEGORIES)[number]

/** Every category an environment sets a mode for. */
export const POLICY_CATEGORIES = [...APPROVAL_CATEGORIES, ...ACTION_CATEGORIES] as const

export type PolicyCategory = (typeof POLICY_CATEGORIES)[number]

/** The categories of a deploy line, which a pull request carries. */
export type LineCategory = Exclude<ApprovalCategory, 'grants'>

/** The mode matrix: `plan` only for a deploy line, `refuse` only for a non-person's action, and `grants` on or off. */
export const LINE_MODES = ['off', 'plan', 'person'] as const
export const GRANT_MODES = ['off', 'person'] as const
export const ACTION_MODES = ['off', 'person', 'refuse'] as const

export type LineMode = (typeof LINE_MODES)[number]
export type GrantMode = (typeof GRANT_MODES)[number]
export type ActionMode = (typeof ACTION_MODES)[number]

/** A mode per category; the type holds the mode matrix, so the gate never meets a mode it cannot decide. */
export type ApprovalPolicy =
	& { readonly [K in LineCategory]: LineMode }
	& { readonly grants: GrantMode }
	& { readonly [K in ActionCategory]: ActionMode }

/** The modes a category takes. */
export function modesOf(category: PolicyCategory): readonly ApprovalMode[] {
	if (category === 'grants') return GRANT_MODES
	if (isActionCategory(category)) return ACTION_MODES
	return LINE_MODES
}

export function isActionCategory(category: PolicyCategory): category is ActionCategory {
	return ACTION_CATEGORIES.some((action) => action === category)
}

/**
 * The strict preset and the default: six of ADR-0050's closer-review reasons `plan`, `deletes-data` `person` (what it
 * deletes depends on production rows no reviewer saw), the permission categories and `grants` `off`, and every action
 * of a non-person `person`.
 */
export const STRICT_POLICY: ApprovalPolicy = {
	'off-road': 'plan',
	'anyone-calls': 'plan',
	'get-mutation': 'plan',
	people: 'plan',
	adoption: 'plan',
	terminal: 'plan',
	'deletes-data': 'person',
	'role-actions': 'off',
	'role-external': 'off',
	'role-added': 'off',
	public: 'off',
	csp: 'off',
	grants: 'off',
	'deploy-request': 'person',
	secrets: 'person',
	variables: 'person',
	data: 'person',
	registry: 'person',
	'agent-grants': 'person',
	credentials: 'person',
}

/** The permissive preset: nothing waits. The environment stays protected, so its lines are still classified and recorded. */
export const PERMISSIVE_POLICY: ApprovalPolicy = {
	'off-road': 'off',
	'anyone-calls': 'off',
	'get-mutation': 'off',
	people: 'off',
	adoption: 'off',
	terminal: 'off',
	'deletes-data': 'off',
	'role-actions': 'off',
	'role-external': 'off',
	'role-added': 'off',
	public: 'off',
	csp: 'off',
	grants: 'off',
	'deploy-request': 'off',
	secrets: 'off',
	variables: 'off',
	data: 'off',
	registry: 'off',
	'agent-grants': 'off',
	credentials: 'off',
}

const lineMode = z.enum(LINE_MODES)
const actionMode = z.enum(ACTION_MODES)

/** A policy checked against the mode matrix; a category this release does not know (a newer one's) is dropped. */
export const approvalPolicySchema = z.object({
	'off-road': lineMode,
	'anyone-calls': lineMode,
	'get-mutation': lineMode,
	people: lineMode,
	adoption: lineMode,
	terminal: lineMode,
	'deletes-data': lineMode,
	'role-actions': lineMode,
	'role-external': lineMode,
	'role-added': lineMode,
	public: lineMode,
	csp: lineMode,
	grants: z.enum(GRANT_MODES),
	'deploy-request': actionMode,
	secrets: actionMode,
	variables: actionMode,
	data: actionMode,
	registry: actionMode,
	'agent-grants': actionMode,
	credentials: actionMode,
}) satisfies z.ZodType<ApprovalPolicy, z.ZodTypeDef, unknown>

/**
 * The policy an earlier category list stands for (ADR-0083 §4): a chosen category waits for a person, or for a plan when
 * it is a closer-review one other than `deletes-data`; one not chosen is `off`. The actions keep their defaults.
 */
export function policyFromCategories(categories: readonly ApprovalCategory[]): ApprovalPolicy {
	const chosen = new Set(categories)
	const planned = new Set<ApprovalCategory>(REVIEW_REASONS.filter((reason) => reason !== 'deletes-data'))
	const line = (category: LineCategory): LineMode => !chosen.has(category) ? 'off' : planned.has(category) ? 'plan' : 'person'
	return {
		...STRICT_POLICY,
		'off-road': line('off-road'),
		'anyone-calls': line('anyone-calls'),
		'get-mutation': line('get-mutation'),
		people: line('people'),
		adoption: line('adoption'),
		terminal: line('terminal'),
		'deletes-data': line('deletes-data'),
		'role-actions': line('role-actions'),
		'role-external': line('role-external'),
		'role-added': line('role-added'),
		public: line('public'),
		csp: line('csp'),
		grants: chosen.has('grants') ? 'person' : 'off',
	}
}

/** The earlier categories that wait under a policy, in `APPROVAL_CATEGORIES` order: what a Control released before it reads. */
export function waitingCategories(policy: ApprovalPolicy): ApprovalCategory[] {
	return APPROVAL_CATEGORIES.filter((category) => policy[category] !== 'off')
}

/** Which approved changes a plan covers (ADR-0083 §2). Until plans are built none exists, and `plan` waits as `person`. */
export interface ApprovalPlan {
	covers(change: CategorizedChange): boolean
}

/** A change the gate judges: a deploy run's lines, and the categories of a non-person's action, if it is one. */
export interface GatedChange<T extends CategorizedChange> {
	readonly lines: readonly T[]
	readonly actions?: readonly ActionCategory[]
}

export type GateOutcome<T extends CategorizedChange> =
	| { readonly kind: 'pass' }
	/** Waits for a person: the lines no plan covers, the actions that wait, and the strictest mode among them. */
	| { readonly kind: 'wait'; readonly mode: 'plan' | 'person'; readonly lines: readonly T[]; readonly actions: readonly ActionCategory[] }
	/** A non-person may not do it at all: the action categories set to `refuse`. */
	| { readonly kind: 'refuse'; readonly categories: readonly ActionCategory[] }

const RANK: Readonly<Record<ApprovalMode, number>> = { off: 0, plan: 1, person: 2, refuse: 3 }

function stricter(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
	return RANK[b] > RANK[a] ? b : a
}

/**
 * Whether a change passes, waits for a person or is refused (ADR-0083 §2). A line takes the strictest mode among its
 * categories; a `plan` line passes when the plan covers it, a `person` line never does. The change waits until every
 * line and action is satisfied, and an action set to `refuse` refuses the whole change.
 */
export function gate<T extends CategorizedChange>(change: GatedChange<T>, policy: ApprovalPolicy, plan?: ApprovalPlan): GateOutcome<T> {
	const actions = change.actions ?? []
	const refused = actions.filter((category) => policy[category] === 'refuse')
	if (refused.length > 0) return { kind: 'refuse', categories: refused }
	let mode: ApprovalMode = 'off'
	const lines: T[] = []
	for (const line of change.lines) {
		const lineMode = changeCategories(line).reduce<ApprovalMode>((held, category) => stricter(held, policy[category]), 'off')
		if (lineMode === 'off' || (lineMode === 'plan' && plan?.covers(line) === true)) continue
		lines.push(line)
		mode = stricter(mode, lineMode)
	}
	const waiting = actions.filter((category) => policy[category] !== 'off')
	for (const category of waiting) mode = stricter(mode, policy[category])
	if (mode === 'off') return { kind: 'pass' }
	return { kind: 'wait', mode: mode === 'plan' ? 'plan' : 'person', lines, actions: waiting }
}
