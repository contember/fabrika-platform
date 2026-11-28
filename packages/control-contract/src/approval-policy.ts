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

/**
 * What a protected environment waits for when nobody chose otherwise: ADR-0050's closer-review reasons, a role opened to
 * external principals, an endpoint anyone opens and a CSP origin.
 */
export const DEFAULT_APPROVAL_CATEGORIES: readonly ApprovalCategory[] = [...REVIEW_REASONS, 'role-external', 'public', 'csp']

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

/**
 * A `write` grant a person approves for an agent to act as them at the environment (ADR-0090 §5). IAM judges it when
 * the person approves and at every exchange, from Control's mirror; it is no action of Control's, so `gate` never meets it.
 */
export const AGENT_WRITE_CATEGORY = 'agent-write'

export type AgentWriteCategory = typeof AGENT_WRITE_CATEGORY

/** Every category an environment sets a mode for. */
export const POLICY_CATEGORIES = [...APPROVAL_CATEGORIES, ...ACTION_CATEGORIES, AGENT_WRITE_CATEGORY] as const

export type PolicyCategory = (typeof POLICY_CATEGORIES)[number]

/** The categories of a deploy line, which a pull request carries. */
export type LineCategory = Exclude<ApprovalCategory, 'grants'>

/** The mode matrix: `plan` only for a deploy line, `refuse` only for a non-person's action, and `grants` on or off. */
export const LINE_MODES = ['off', 'plan', 'person'] as const
export const GRANT_MODES = ['off', 'person'] as const
export const ACTION_MODES = ['off', 'person', 'refuse'] as const
/** `plan` and `person` do not apply: the device page is already a person's decision on exactly this grant. */
export const AGENT_WRITE_MODES = ['off', 'refuse'] as const

export type LineMode = (typeof LINE_MODES)[number]
export type GrantMode = (typeof GRANT_MODES)[number]
export type ActionMode = (typeof ACTION_MODES)[number]
export type AgentWriteMode = (typeof AGENT_WRITE_MODES)[number]

/** A mode per category; the type holds the mode matrix, so the gate never meets a mode it cannot decide. */
export type ApprovalPolicy =
	& { readonly [K in LineCategory]: LineMode }
	& { readonly grants: GrantMode }
	& { readonly [K in ActionCategory]: ActionMode }
	& { readonly 'agent-write': AgentWriteMode }

/** The modes a category takes. */
export function modesOf(category: PolicyCategory): readonly ApprovalMode[] {
	if (category === 'grants') return GRANT_MODES
	if (category === AGENT_WRITE_CATEGORY) return AGENT_WRITE_MODES
	if (isActionCategory(category)) return ACTION_MODES
	return LINE_MODES
}

export function isActionCategory(category: PolicyCategory): category is ActionCategory {
	return ACTION_CATEGORIES.some((action) => action === category)
}

/**
 * The strict preset and the default: six of ADR-0050's closer-review reasons `plan`, `deletes-data` `person` (what it
 * deletes depends on production rows no reviewer saw), `role-external`, `public` and `csp` `person` (each lets someone
 * outside the organization reach the application, or the page reach another origin), `role-actions`, `role-added` and
 * `grants` `off`, every action of a non-person `person`, and `agent-write` `off` (its passkey is a setting).
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
	'role-external': 'person',
	'role-added': 'off',
	public: 'person',
	csp: 'person',
	grants: 'off',
	'deploy-request': 'person',
	secrets: 'person',
	variables: 'person',
	data: 'person',
	registry: 'person',
	'agent-grants': 'person',
	credentials: 'person',
	'agent-write': 'off',
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
	'agent-write': 'off',
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
	'agent-write': z.enum(AGENT_WRITE_MODES),
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

/** Which approved changes a plan covers (ADR-0083 §2). Without one, `plan` waits as `person`. */
export interface ApprovalPlan<T extends CategorizedChange = CategorizedChange> {
	covers(change: T): boolean
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
export function gate<T extends CategorizedChange>(change: GatedChange<T>, policy: ApprovalPolicy, plan?: ApprovalPlan<T>): GateOutcome<T> {
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

/** Which commit a non-person may ask to deploy to a protected environment (ADR-0050 §4): a merged one, or any. */
export const DEPLOY_REQUEST_COMMITS = ['merged', 'any'] as const

export type DeployRequestCommits = (typeof DEPLOY_REQUEST_COMMITS)[number]

/**
 * The categories whose pending items take one or two approvers (ADR-0083 §2). `grants` waits in IAM, under IAM's own
 * rule, and `agent-write` has no pending item: the person approving the grant decides it on IAM's device page.
 */
export type ApproverCategory = Exclude<PolicyCategory, 'grants' | AgentWriteCategory>

export function isApproverCategory(category: PolicyCategory): category is ApproverCategory {
	return category !== 'grants' && category !== AGENT_WRITE_CATEGORY
}

export const APPROVER_CATEGORIES: readonly ApproverCategory[] = POLICY_CATEGORIES.filter(isApproverCategory)

/** The categories that take a passkey setting: every approver category, and `agent-write`, whose passkey IAM's device page asks. */
export type StepUpCategory = ApproverCategory | AgentWriteCategory

export function isStepUpCategory(category: PolicyCategory): category is StepUpCategory {
	return category !== 'grants'
}

export const STEP_UP_CATEGORIES: readonly StepUpCategory[] = POLICY_CATEGORIES.filter(isStepUpCategory)

/** How many different people decide a pending item of a category. */
export type ApproverCount = 1 | 2

/** The bounds of `requestTtlHours`: the absolute deadline of a pending item, counted from when it starts waiting. */
export const REQUEST_TTL_HOURS = { min: 1, max: 168, default: 24 } as const

/**
 * What an approved plan entry binds to (ADR-0050 §5, D6): `transition`, the subject's content before and after as the
 * approver saw it, so a deploy whose baseline holds something else waits; `after-state`, the content after only.
 */
export const PLAN_BINDINGS = ['transition', 'after-state'] as const

export type PlanBinding = (typeof PLAN_BINDINGS)[number]

/** The bounds of `planTtlDays`: how long an approved plan's entries cover a deploy, counted from the approval. */
export const PLAN_TTL_DAYS = { min: 1, max: 365, default: 30 } as const

/** What deciding a pending item takes beyond the session: nothing, or a passkey assertion bound to the decision. */
export const STEP_UP_MODES = ['none', 'webauthn'] as const

export type StepUpMode = (typeof STEP_UP_MODES)[number]

/**
 * What bounds a key an agent asks for someone else (ADR-0083 §2): the actions the requester itself holds at the
 * application, read from its token when it asks, or the approver's own, the page warning which exceed the requester's.
 */
export const CREDENTIAL_CEILINGS = ['requester', 'approver'] as const

export type CredentialCeiling = (typeof CREDENTIAL_CEILINGS)[number]

/** An environment's approval settings beside its modes (ADR-0083 §2). */
export interface ApprovalSettings {
	readonly deployRequestCommits: DeployRequestCommits
	readonly requestTtlHours: number
	readonly credentialCeiling: CredentialCeiling
	readonly planBinding: PlanBinding
	readonly planTtlDays: number
	readonly approvers: { readonly [K in ApproverCategory]: ApproverCount }
	/** `false`: someone other than the requester's person decides a pending item of the category (ADR-0083 §8). */
	readonly requesterMayApprove: { readonly [K in ApproverCategory]: boolean }
	/**
	 * `webauthn`: deciding a pending item of the category takes a passkey assertion bound to the decision (ADR-0050 §5);
	 * for `agent-write`, approving an agent's `write` grant takes one bound to the device attempt (ADR-0090 §5).
	 */
	readonly stepUp: { readonly [K in StepUpCategory]: StepUpMode }
}

/**
 * The strict preset's settings, and the defaults: merged commits only, a day to decide, a key no wider than its
 * requester, a plan bound to the transition its approver saw and covering for 30 days, one approver per category, the requester's own person may decide (D2), and a passkey on deciding a request
 * for a credential and on approving an agent's `write` grant.
 */
export const STRICT_SETTINGS: ApprovalSettings = {
	deployRequestCommits: 'merged',
	requestTtlHours: REQUEST_TTL_HOURS.default,
	credentialCeiling: 'requester',
	planBinding: 'transition',
	planTtlDays: PLAN_TTL_DAYS.default,
	approvers: {
		'off-road': 1,
		'anyone-calls': 1,
		'get-mutation': 1,
		people: 1,
		adoption: 1,
		terminal: 1,
		'deletes-data': 1,
		'role-actions': 1,
		'role-external': 1,
		'role-added': 1,
		public: 1,
		csp: 1,
		'deploy-request': 1,
		secrets: 1,
		variables: 1,
		data: 1,
		registry: 1,
		'agent-grants': 1,
		credentials: 1,
	},
	requesterMayApprove: {
		'off-road': true,
		'anyone-calls': true,
		'get-mutation': true,
		people: true,
		adoption: true,
		terminal: true,
		'deletes-data': true,
		'role-actions': true,
		'role-external': true,
		'role-added': true,
		public: true,
		csp: true,
		'deploy-request': true,
		secrets: true,
		variables: true,
		data: true,
		registry: true,
		'agent-grants': true,
		credentials: true,
	},
	stepUp: {
		'off-road': 'none',
		'anyone-calls': 'none',
		'get-mutation': 'none',
		people: 'none',
		adoption: 'none',
		terminal: 'none',
		'deletes-data': 'none',
		'role-actions': 'none',
		'role-external': 'none',
		'role-added': 'none',
		public: 'none',
		csp: 'none',
		'deploy-request': 'none',
		secrets: 'none',
		variables: 'none',
		data: 'none',
		registry: 'none',
		'agent-grants': 'none',
		credentials: 'webauthn',
		'agent-write': 'webauthn',
	},
}

/**
 * The permissive preset's settings (ADR-0083 §7): an agent may ask for any commit that is not a workspace branch, and no
 * decision takes a passkey.
 */
export const PERMISSIVE_SETTINGS: ApprovalSettings = {
	...STRICT_SETTINGS,
	deployRequestCommits: 'any',
	stepUp: {
		'off-road': 'none',
		'anyone-calls': 'none',
		'get-mutation': 'none',
		people: 'none',
		adoption: 'none',
		terminal: 'none',
		'deletes-data': 'none',
		'role-actions': 'none',
		'role-external': 'none',
		'role-added': 'none',
		public: 'none',
		csp: 'none',
		'deploy-request': 'none',
		secrets: 'none',
		variables: 'none',
		data: 'none',
		registry: 'none',
		'agent-grants': 'none',
		credentials: 'none',
		'agent-write': 'none',
	},
}

const approverCount = z.union([z.literal(1), z.literal(2)])

const approversSchema = z.object({
	'off-road': approverCount,
	'anyone-calls': approverCount,
	'get-mutation': approverCount,
	people: approverCount,
	adoption: approverCount,
	terminal: approverCount,
	'deletes-data': approverCount,
	'role-actions': approverCount,
	'role-external': approverCount,
	'role-added': approverCount,
	public: approverCount,
	csp: approverCount,
	'deploy-request': approverCount,
	secrets: approverCount,
	variables: approverCount,
	data: approverCount,
	registry: approverCount,
	'agent-grants': approverCount,
	credentials: approverCount,
})

const requesterMayApproveSchema = z.object({
	'off-road': z.boolean(),
	'anyone-calls': z.boolean(),
	'get-mutation': z.boolean(),
	people: z.boolean(),
	adoption: z.boolean(),
	terminal: z.boolean(),
	'deletes-data': z.boolean(),
	'role-actions': z.boolean(),
	'role-external': z.boolean(),
	'role-added': z.boolean(),
	public: z.boolean(),
	csp: z.boolean(),
	'deploy-request': z.boolean(),
	secrets: z.boolean(),
	variables: z.boolean(),
	data: z.boolean(),
	registry: z.boolean(),
	'agent-grants': z.boolean(),
	credentials: z.boolean(),
})

const stepUpMode = z.enum(STEP_UP_MODES)

const stepUpSchema = z.object({
	'off-road': stepUpMode,
	'anyone-calls': stepUpMode,
	'get-mutation': stepUpMode,
	people: stepUpMode,
	adoption: stepUpMode,
	terminal: stepUpMode,
	'deletes-data': stepUpMode,
	'role-actions': stepUpMode,
	'role-external': stepUpMode,
	'role-added': stepUpMode,
	public: stepUpMode,
	csp: stepUpMode,
	'deploy-request': stepUpMode,
	secrets: stepUpMode,
	variables: stepUpMode,
	data: stepUpMode,
	registry: stepUpMode,
	'agent-grants': stepUpMode,
	credentials: stepUpMode,
	'agent-write': stepUpMode,
})

/** Settings checked against their bounds; a category or a setting this release does not know (a newer one's) is dropped. */
export const approvalSettingsSchema = z.object({
	deployRequestCommits: z.enum(DEPLOY_REQUEST_COMMITS),
	requestTtlHours: z.number().int().min(REQUEST_TTL_HOURS.min).max(REQUEST_TTL_HOURS.max),
	credentialCeiling: z.enum(CREDENTIAL_CEILINGS),
	planBinding: z.enum(PLAN_BINDINGS),
	planTtlDays: z.number().int().min(PLAN_TTL_DAYS.min).max(PLAN_TTL_DAYS.max),
	approvers: approversSchema,
	requesterMayApprove: requesterMayApproveSchema,
	stepUp: stepUpSchema,
}) satisfies z.ZodType<ApprovalSettings, z.ZodTypeDef, unknown>

/**
 * How many people decide a pending item: the most any of its waiting categories asks for, so the strictest wins
 * (ADR-0083 §8). `grants` takes IAM's own rule and counts as one here.
 */
export function requiredApprovers(settings: ApprovalSettings, categories: Iterable<PolicyCategory>): ApproverCount {
	for (const category of categories) {
		if (isApproverCategory(category) && settings.approvers[category] === 2) return 2
	}
	return 1
}

/**
 * What deciding a pending item takes: a passkey when any of its waiting categories says `webauthn`, so the strictest
 * wins (ADR-0083 §8). `grants` is decided in IAM and counts as `none` here.
 */
export function requiredStepUp(settings: ApprovalSettings, categories: Iterable<PolicyCategory>): StepUpMode {
	for (const category of categories) {
		if (isApproverCategory(category) && settings.stepUp[category] === 'webauthn') return 'webauthn'
	}
	return 'none'
}

/** What an environment's protection holds, or a change asks for: the flag, the modes and the settings. */
export interface ProtectionChoice {
	readonly protected: boolean
	readonly policy: ApprovalPolicy
	readonly settings: ApprovalSettings
}

/**
 * The categories whose deciding takes a passkey under `held` that a change to `after` lets more through (ADR-0050 §5):
 * the environment unprotected, the passkey dropped, the mode lowered, fewer approvers, the requester's person let
 * approve, for `deploy-request` an unmerged commit admitted, for `credentials` a key no longer bounded by its
 * requester, or a plan bound to its result alone, which widens what entries approved with a passkey already cover
 * (a longer `planTtlDays` is not one: an entry's expiry is fixed when it is approved). Such a change takes a passkey too, so a driven browser cannot loosen the setting and then decide without
 * one. An unprotected environment decides requests under `STRICT_SETTINGS` (ADR-0083 §2), so protecting it with less is
 * a weakening too.
 */
export function weakensStepUp(held: ProtectionChoice, after: ProtectionChoice): StepUpCategory[] {
	const before = decidingSettings(held)
	const next = decidingSettings(after)
	// `agent-write` has no pending item an unprotected environment decides under the defaults: there it asks nothing, so
	// only a protected environment's passkey, its protection and its mode loosen it.
	const agentWrite = held.protected && held.settings.stepUp[AGENT_WRITE_CATEGORY] === 'webauthn' && (
		!after.protected
		|| after.settings.stepUp[AGENT_WRITE_CATEGORY] === 'none'
		|| RANK[after.policy[AGENT_WRITE_CATEGORY]] < RANK[held.policy[AGENT_WRITE_CATEGORY]]
	)
	const approvers = APPROVER_CATEGORIES.filter((category) =>
		before.stepUp[category] === 'webauthn' && (
			next.stepUp[category] === 'none'
			|| next.approvers[category] < before.approvers[category]
			|| (next.requesterMayApprove[category] && !before.requesterMayApprove[category])
			|| (category === 'deploy-request' && before.deployRequestCommits === 'merged' && next.deployRequestCommits === 'any')
			|| (category === 'credentials' && before.credentialCeiling === 'requester' && next.credentialCeiling === 'approver')
			|| (before.planBinding === 'transition' && next.planBinding === 'after-state')
			|| (held.protected && (!after.protected || RANK[after.policy[category]] < RANK[held.policy[category]]))
		)
	)
	return agentWrite ? [...approvers, AGENT_WRITE_CATEGORY] : approvers
}

/** The settings a pending item of an environment is decided under: its own while protected, the defaults otherwise. */
function decidingSettings(choice: ProtectionChoice): ApprovalSettings {
	return choice.protected ? choice.settings : STRICT_SETTINGS
}

/**
 * Whether the requester's own person may decide a pending item: not when any of its waiting categories says `false`, so
 * the strictest wins (ADR-0083 §8). `grants` takes IAM's own rule, which never lets the requester approve.
 */
export function requesterMayApprove(settings: ApprovalSettings, categories: Iterable<PolicyCategory>): boolean {
	for (const category of categories) {
		if (isApproverCategory(category) && !settings.requesterMayApprove[category]) return false
	}
	return true
}

/**
 * The person behind a request (ADR-0083 §8): the subject of an OAuth token or of a key bound to a user, and the issuer of
 * a service key. Null when that person cannot be known, a service key whose issuer the token does not name: under
 * `requesterMayApprove: false` nobody may then approve the item, and it can only be refused.
 */
export function requesterPersonId(principal: { readonly id: string; readonly type: string }, issuerId?: string | null): string | null {
	if (principal.type === 'user') return principal.id
	return issuerId ?? null
}
