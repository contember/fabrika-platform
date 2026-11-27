import { RpcError } from '@fabrika/app'
import {
	type AppEnvDto,
	APPROVAL_MODES,
	type ApprovalDto,
	type ApprovalMode,
	type ApprovalPolicy,
	type ApprovalSettings,
	APPROVER_CATEGORIES,
	gate,
	isApproverCategory,
	isStepUpCategory,
	PERMISSIVE_POLICY,
	PERMISSIVE_SETTINGS,
	POLICY_CATEGORIES,
	type PolicyCategory,
	policyFromCategories,
	REQUEST_TTL_HOURS,
	STEP_UP_CATEGORIES,
	type StepUpMode,
	STRICT_POLICY,
	STRICT_SETTINGS,
	weakensStepUp,
} from '@fabrika/control-contract'
import type { createControlClient } from './api'
import { type DecisionFailure, decisionFailure, NoPasskeyError, startDecision, type StartedDecision } from './decision-step-up'

type ControlClient = ReturnType<typeof createControlClient>

/** Turning approvals off waits for an explicit confirmation; turning them on applies at once. */
export type ProtectionToggle = 'confirm' | 'apply'

export function protectionToggle(next: boolean): ProtectionToggle {
	return next ? 'apply' : 'confirm'
}

/** An environment as it holds its protection, which a change is judged against. */
export type HeldProtection = Pick<AppEnvDto, 'appId' | 'env' | 'protected' | 'approvalPolicy' | 'approvalSettings'>

/** A new choice of modes and settings. */
export interface ProtectionChoiceInput {
	readonly policy: ApprovalPolicy
	readonly settings: ApprovalSettings
}

/**
 * What a change of protection takes (ADR-0050 §5): a passkey when it weakens what deciding takes in a category where a
 * passkey confirms deciding under what the environment holds (`weakensStepUp`). Control judges it again.
 */
export function protectionStepUp(held: HeldProtection, value: boolean, choice?: ProtectionChoiceInput): StepUpMode {
	const before = { protected: held.protected, policy: held.approvalPolicy, settings: held.approvalSettings }
	const after = { protected: value, policy: choice?.policy ?? held.approvalPolicy, settings: choice?.settings ?? held.approvalSettings }
	return weakensStepUp(before, after).length > 0 ? 'webauthn' : 'none'
}

/**
 * Control's `apps.environments.protect`: `access.approve` from a person in the console, audited (ADR-0050 §4). With
 * `policy` and `settings`, also the mode of each category and the settings beside them (ADR-0083); without, the stored
 * choice stays. A change that takes a passkey is not sent yet: it answers the check on a challenge bound to it
 * (`protectChallenge`), which sends it with the challenge's id once the person confirmed it on IAM's page.
 */
export function setEnvironmentProtection(
	client: ControlClient,
	held: HeldProtection,
	value: boolean,
	choice: ProtectionChoiceInput | undefined,
): Promise<StartedDecision<AppEnvDto>> {
	const change = { appId: held.appId, env: held.env, protected: value, ...(choice === undefined ? {} : choice) }
	return startDecision(
		protectionStepUp(held, value, choice),
		() => client.apps.environments.protectChallenge(change),
		(stepUp) => client.apps.environments.protect(stepUp === undefined ? change : { ...change, stepUp }),
		'change',
	)
}

/** What the editor's save bar says; while a change waits for its passkey, that it is not saved yet. */
export function saveStatus(changes: number, waitingForPasskey: boolean): string {
	if (waitingForPasskey) return 'Not saved yet: the change waits for your passkey'
	if (changes === 0) return 'No changes'
	return `${changes} ${changes === 1 ? 'change' : 'changes'} to save`
}

export interface CategoryOption {
	readonly category: PolicyCategory
	readonly label: string
	readonly hint: string
	/** An action no request routes yet: its mode is stored, and today's rule applies until its release (ADR-0083, Rollout). */
	readonly pending?: string
}

/** Every approval category, grouped as the console lists them, each with its words (ADR-0083 §1). */
export const APPROVAL_CATEGORY_GROUPS: readonly { readonly title: string; readonly options: readonly CategoryOption[] }[] = [
	{
		title: 'Closer review',
		options: [
			{
				category: 'off-road',
				label: 'Steps off the paved road',
				hint: 'raw or unscoped SQL, connectors, share-link issuing, a contract outside the staged kit, access views, database code',
			},
			{ category: 'anyone-calls', label: 'Something anyone sets off', hint: 'a public procedure, the actions it holds, a job it starts' },
			{ category: 'get-mutation', label: 'A change of state on GET', hint: 'link scanners may trigger it' },
			{ category: 'people', label: 'People becoming visible', hint: "who holds the application's roles, or labels that spell addresses" },
			{ category: 'adoption', label: 'Files adopted or released', hint: 'a file collection adopted into a table, or released' },
			{ category: 'terminal', label: 'Terminal sign-in', hint: 'the application names who signs in at an enrolled terminal' },
			{ category: 'deletes-data', label: 'Migrations that may change stored data', hint: 'a statement not known to keep every stored value' },
		],
	},
	{
		title: 'Permissions',
		options: [
			{ category: 'role-actions', label: 'A role gains an action', hint: 'directly, or through a relation' },
			{ category: 'role-external', label: 'A role opened to external people', hint: 'people from outside the organization may hold it' },
			{ category: 'role-added', label: 'A new role', hint: 'declared in the contract' },
			{ category: 'grants', label: 'Console grants and revocations', hint: 'IAM holds each until another administrator approves it' },
		],
	},
	{
		title: 'Pages',
		options: [
			{ category: 'public', label: 'A page or endpoint anyone opens', hint: 'a new one, or one that becomes public' },
			{ category: 'csp', label: 'A new origin in the CSP', hint: 'a page may load from or connect to another origin' },
		],
	},
	{
		title: 'What an agent or a key does',
		options: [
			{
				category: 'deploy-request',
				label: 'A deploy started by an agent or a key',
				hint: 'a manual run by anyone but a person in the console, of a commit it names by SHA',
			},
			{
				category: 'secrets',
				label: 'Secrets',
				hint: 'setting, rotating or deleting a secret, the all-environments layer included',
				pending: 'Today it applies at once.',
			},
			{
				category: 'variables',
				label: 'Variables',
				hint: 'setting or deleting a variable, the all-environments layer included',
				pending: 'Today it applies at once.',
			},
			{
				category: 'data',
				label: 'Data operations',
				hint: 'maintenance, a restore, a recovery, suspend and resume, the backup schedule',
				pending: 'Today it applies at once.',
			},
			{
				category: 'registry',
				label: 'Where a deploy points',
				hint: 'the trigger ref, domain, public origin, source and build, cross-origins, target, artifact and namespace',
				pending: 'Today the trigger ref, domain, public origin and source are refused, and the rest applies at once.',
			},
			{
				category: 'agent-grants',
				label: 'A grant an agent asks for',
				hint: 'a role at this application, decided by its IAM administrators; with no approval an agent cannot ask for one',
			},
			{
				category: 'credentials',
				label: 'A key an agent asks for',
				hint:
					'a key for someone else, decided by an IAM installation administrator, encrypted to the agent and fetched by it once; with no approval an agent cannot ask for one',
			},
			{
				category: 'agent-write',
				label: 'An agent writing as a person',
				hint:
					"a person lets an agent act as them with changes, on IAM's approval page; while that takes a passkey, the person confirms it there with one",
			},
		],
	},
]

/** What a category's passkey confirms: deciding a pending item, or, for `agent-write`, allowing an agent to write. */
export function stepUpVerb(category: PolicyCategory): string {
	return category === 'agent-write' ? 'to allow' : 'to decide'
}

export function categoryLabel(category: PolicyCategory): string {
	return APPROVAL_CATEGORY_GROUPS.flatMap((group) => group.options).find((option) => option.category === category)?.label ?? category
}

/** What lets a change of a category through, in the console's words. */
export function modeLabel(mode: ApprovalMode): string {
	switch (mode) {
		case 'off':
			return 'No approval'
		case 'plan':
			return 'A plan or a person'
		case 'person':
			return 'A person approves'
		case 'refuse':
			return 'Refused'
	}
}

/** The categories a change of policy loosens: their mode lets more through than before. */
export function loosened(before: ApprovalPolicy, after: ApprovalPolicy): PolicyCategory[] {
	return POLICY_CATEGORIES.filter((category) => APPROVAL_MODES.indexOf(after[category]) < APPROVAL_MODES.indexOf(before[category]))
}

/**
 * The settings a change loosens, in the console's words: an unmerged commit admitted, a key no longer bounded by its
 * requester, one approver where two decided, the requester's own person allowed to approve, or a decision (or an
 * agent's write access) no longer confirmed with a passkey.
 */
export function loosenedSettings(before: ApprovalSettings, after: ApprovalSettings): string[] {
	return [
		...(before.deployRequestCommits === 'merged' && after.deployRequestCommits === 'any' ? ['an agent may ask to deploy an unmerged commit'] : []),
		...(before.credentialCeiling === 'requester' && after.credentialCeiling === 'approver'
			? ['a key an agent asks for may hold actions the agent does not']
			: []),
		...APPROVER_CATEGORIES.filter((category) => after.approvers[category] < before.approvers[category]).map((category) =>
			`${categoryLabel(category)} (one approver)`
		),
		...APPROVER_CATEGORIES.filter((category) => after.requesterMayApprove[category] && !before.requesterMayApprove[category]).map((category) =>
			`${categoryLabel(category)} (the requester's person may approve)`
		),
		...STEP_UP_CATEGORIES.filter((category) => after.stepUp[category] === 'none' && before.stepUp[category] === 'webauthn').map((category) =>
			`${categoryLabel(category)} (no passkey ${stepUpVerb(category)})`
		),
	]
}

/** Saving a choice that loosens a category or a setting waits for an explicit confirmation, as turning approvals off does. */
export function policyChange(
	before: { readonly policy: ApprovalPolicy; readonly settings: ApprovalSettings },
	after: { readonly policy: ApprovalPolicy; readonly settings: ApprovalSettings },
): ProtectionToggle {
	return loosened(before.policy, after.policy).length > 0 || loosenedSettings(before.settings, after.settings).length > 0 ? 'confirm' : 'apply'
}

export const PRESETS = [
	{ name: 'strict', label: 'Strict', hint: 'a person approves what an agent asks for; the default', policy: STRICT_POLICY, settings: STRICT_SETTINGS },
	{
		name: 'permissive',
		label: 'Permissive',
		hint: 'an agent configures and deploys any commit with no approval',
		policy: PERMISSIVE_POLICY,
		settings: PERMISSIVE_SETTINGS,
	},
] as const

/** Whether two sets of settings say the same. */
export function sameSettings(a: ApprovalSettings, b: ApprovalSettings): boolean {
	return a.deployRequestCommits === b.deployRequestCommits && a.requestTtlHours === b.requestTtlHours && a.credentialCeiling === b.credentialCeiling
		&& APPROVER_CATEGORIES.every((category) =>
			a.approvers[category] === b.approvers[category] && a.requesterMayApprove[category] === b.requesterMayApprove[category]
		)
		&& STEP_UP_CATEGORIES.every((category) => a.stepUp[category] === b.stepUp[category])
}

/** The preset a choice is, if any. */
export function presetOf(policy: ApprovalPolicy, settings: ApprovalSettings): (typeof PRESETS)[number]['name'] | null {
	return PRESETS.find((preset) =>
		POLICY_CATEGORIES.every((category) => preset.policy[category] === policy[category]) && sameSettings(preset.settings, settings)
	)?.name ?? null
}

export type PresetName = (typeof PRESETS)[number]['name']

/** An environment's modes and settings together: what a preset, a saved policy or an edit holds. */
export interface PolicyChoice {
	readonly policy: ApprovalPolicy
	readonly settings: ApprovalSettings
}

/** Every category in the console's order. */
const ORDERED_OPTIONS: readonly CategoryOption[] = APPROVAL_CATEGORY_GROUPS.flatMap((group) => group.options)

/**
 * Who decides a category's pending item and what confirms it, in a few words: "1 person" by default, then only what
 * differs. `grants` waits in IAM under IAM's own rule, so it has none.
 */
export function decidingText(category: PolicyCategory, settings: ApprovalSettings): string | null {
	if (!isStepUpCategory(category)) return null
	const parts: string[] = []
	if (isApproverCategory(category)) {
		parts.push(settings.approvers[category] === 2 ? '2 people' : '1 person')
		if (!settings.requesterMayApprove[category]) parts.push('not the requester')
	}
	if (settings.stepUp[category] === 'webauthn') parts.push('passkey')
	return parts.length === 0 ? 'no passkey' : parts.join(' · ')
}

/**
 * Whether who decides takes effect under a mode: a rule waits for a person only under `plan` or `person`, while an
 * agent writes as a person under `off`, after the passkey its person confirms.
 */
export function decidingApplies(category: PolicyCategory, mode: ApprovalMode): boolean {
	return category === 'agent-write' ? mode === 'off' : mode === 'plan' || mode === 'person'
}

/** The rules whose stored mode asks for more than today's rule does: no request routes them yet (ADR-0083, Rollout). */
export function notEnforcedYet(policy: ApprovalPolicy): readonly CategoryOption[] {
	return ORDERED_OPTIONS.filter((option) => option.pending !== undefined && policy[option.category] !== 'off')
}

/** One rule or setting that differs between two choices, in the console's words. */
export interface PolicyDifference {
	readonly key: string
	readonly label: string
	readonly value: string
	readonly other: string
	/** What applies today to a category no request routes yet, whatever its stored mode says. */
	readonly pending?: string
}

/** What `choice` says differently from `base`: each category whose mode or deciding differs, then each request setting. */
export function policyDifferences(choice: PolicyChoice, base: PolicyChoice): PolicyDifference[] {
	const rules = ORDERED_OPTIONS.flatMap(({ category, pending }): PolicyDifference[] => {
		const mode = choice.policy[category]
		const baseMode = base.policy[category]
		const deciding = decidingText(category, choice.settings)
		const baseDeciding = decidingText(category, base.settings)
		if (mode === baseMode && deciding === baseDeciding) return []
		// Who decides is named where it differs and takes effect, or where it is the only difference.
		const named = (text: string | null, ruleMode: ApprovalMode) =>
			text !== null && deciding !== baseDeciding && (decidingApplies(category, ruleMode) || mode === baseMode)
				? `${modeLabel(ruleMode)} · ${text}`
				: modeLabel(ruleMode)
		const difference = { key: category, label: categoryLabel(category), value: named(deciding, mode), other: named(baseDeciding, baseMode) }
		return [pending === undefined ? difference : { ...difference, pending }]
	})
	const settings: PolicyDifference[] = [
		...(choice.settings.deployRequestCommits === base.settings.deployRequestCommits ? [] : [{
			key: 'deployRequestCommits',
			label: 'Commits an agent may ask to deploy',
			value: commitsLabel(choice.settings),
			other: commitsLabel(base.settings),
		}]),
		...(choice.settings.credentialCeiling === base.settings.credentialCeiling ? [] : [{
			key: 'credentialCeiling',
			label: 'Actions a key an agent asks for may hold',
			value: ceilingLabel(choice.settings),
			other: ceilingLabel(base.settings),
		}]),
		...(choice.settings.requestTtlHours === base.settings.requestTtlHours ? [] : [{
			key: 'requestTtlHours',
			label: 'Hours a request waits for a decision',
			value: `${choice.settings.requestTtlHours} h`,
			other: `${base.settings.requestTtlHours} h`,
		}]),
	]
	return [...rules, ...settings]
}

/** The commits an agent may ask to deploy, in the console's words. */
export function commitsLabel(settings: ApprovalSettings): string {
	return settings.deployRequestCommits === 'merged' ? 'Merged commits' : 'Any commit'
}

/** The actions a key an agent asks for may hold, in the console's words. */
export function ceilingLabel(settings: ApprovalSettings): string {
	return settings.credentialCeiling === 'requester' ? "The agent's own" : "The approver's"
}

/** The preset a choice is closest to, counted in differing rules and settings; Strict on a tie. */
export function nearestPreset(choice: PolicyChoice): { readonly preset: (typeof PRESETS)[number]; readonly differences: PolicyDifference[] } {
	const [strict, permissive] = PRESETS
	const fromStrict = { preset: strict, differences: policyDifferences(choice, strict) }
	const fromPermissive = { preset: permissive, differences: policyDifferences(choice, permissive) }
	return fromPermissive.differences.length < fromStrict.differences.length ? fromPermissive : fromStrict
}

/** A number of hours a request waits, or null for one outside `requestTtlHours`'s bounds. */
export function requestTtl(text: string): number | null {
	const hours = Number(text)
	return Number.isInteger(hours) && hours >= REQUEST_TTL_HOURS.min && hours <= REQUEST_TTL_HOURS.max ? hours : null
}

/** Whether a run's change waits for a person under the categories it was classified under (ADR-0083 §3). */
export function changeWaits(approval: Pick<ApprovalDto, 'changes' | 'categories'>): boolean {
	return gate({ lines: approval.changes }, policyFromCategories(approval.categories)).kind !== 'pass'
}

/** The deploys of one environment that wait for a person; turning approvals off decides none of them. */
export function parkedRunsAt(approvals: readonly ApprovalDto[], appId: string, env: string): ApprovalDto[] {
	return approvals.filter((approval) => approval.run.appId === appId && approval.run.env === env)
}

/**
 * Why a change of protection was not saved: a person without a passkey as the approval pages say it, and Control's own
 * words for a refusal, or for a conflict of a change that took a passkey, because the passkey check or IAM may be what
 * refused it, whatever this page expected. Any other failure in the console's words.
 */
export function protectionChangeFailure(cause: unknown, env: string, stepUp: StepUpMode): DecisionFailure {
	if (cause instanceof NoPasskeyError) return decisionFailure(cause)
	if (cause instanceof RpcError && (cause.httpStatus === 403 || (stepUp === 'webauthn' && cause.httpStatus === 409))) {
		return { message: cause.message, noPasskey: false }
	}
	return { message: protectionFailure(cause, env), noPasskey: false }
}

export function protectionFailure(cause: unknown, env: string): string {
	if (!(cause instanceof RpcError)) return 'Changing approvals failed.'
	switch (cause.httpStatus) {
		case 409:
			return `A deploy of ${env} is running. Approvals change between deploys: try again when it finishes.`
		case 403:
			return 'Only a person signed in to the console changes approvals, never a key or an agent.'
		case 404:
			return `You do not hold access.approve on ${env}, or the environment no longer exists.`
		default:
			return cause.message
	}
}

/**
 * Whether the viewer may approve an item a request asked for (ADR-0083 §8): under `requesterMayApprove: false` not the
 * requester's person, and nobody when that person is unknown (a service key). Control decides again.
 */
export function requesterBlocks(requesterMayApprove: boolean, personId: string | null, me: string | null): 'nobody' | 'you' | null {
	if (requesterMayApprove) return null
	if (personId === null) return 'nobody'
	return personId === me ? 'you' : null
}

/** Why the viewer has no approve button on an item a request asked for. */
export function requesterBlockText(blocked: 'nobody' | 'you', item: 'deploy' | 'request'): string {
	return blocked === 'you'
		? `It was asked for on your behalf, and this environment lets only someone other than the requester's person approve it. You may refuse it.`
		: `A service key asked for this ${item}, and this environment lets only someone other than the key's issuer approve it, whom Control cannot know: `
			+ 'nobody can approve it. You may refuse it.'
}
