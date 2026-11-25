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
	PERMISSIVE_POLICY,
	PERMISSIVE_SETTINGS,
	POLICY_CATEGORIES,
	type PolicyCategory,
	policyFromCategories,
	REQUEST_TTL_HOURS,
	STRICT_POLICY,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import type { createControlClient } from './api'

type ControlClient = ReturnType<typeof createControlClient>

/** Turning approvals off waits for an explicit confirmation; turning them on applies at once. */
export type ProtectionToggle = 'confirm' | 'apply'

export function protectionToggle(next: boolean): ProtectionToggle {
	return next ? 'apply' : 'confirm'
}

/**
 * Control's `apps.environments.protect`: `access.approve` from a person in the console, audited (ADR-0050 §4). With
 * `policy` and `settings`, also the mode of each category and the settings beside them (ADR-0083); without, the stored
 * choice stays.
 */
export function setEnvironmentProtection(
	client: ControlClient,
	appId: string,
	env: string,
	value: boolean,
	choice?: { readonly policy: ApprovalPolicy; readonly settings: ApprovalSettings },
): Promise<AppEnvDto> {
	return client.apps.environments.protect({ appId, env, protected: value, ...(choice === undefined ? {} : choice) })
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
			{ category: 'agent-grants', label: 'A grant an agent asks for', hint: 'a role at this application', pending: 'Today an agent cannot ask.' },
			{
				category: 'credentials',
				label: 'A key an agent asks for',
				hint: 'issued to someone other than the agent, encrypted to the agent',
				pending: 'Today an agent cannot ask.',
			},
		],
	},
]

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

export function isDefaultMode(category: PolicyCategory, mode: ApprovalMode): boolean {
	return STRICT_POLICY[category] === mode
}

/** The categories a change of policy loosens: their mode lets more through than before. */
export function loosened(before: ApprovalPolicy, after: ApprovalPolicy): PolicyCategory[] {
	return POLICY_CATEGORIES.filter((category) => APPROVAL_MODES.indexOf(after[category]) < APPROVAL_MODES.indexOf(before[category]))
}

/**
 * The settings a change loosens, in the console's words: an unmerged commit admitted, one approver where two decided, or
 * the requester's own person allowed to approve.
 */
export function loosenedSettings(before: ApprovalSettings, after: ApprovalSettings): string[] {
	return [
		...(before.deployRequestCommits === 'merged' && after.deployRequestCommits === 'any' ? ['an agent may ask to deploy an unmerged commit'] : []),
		...APPROVER_CATEGORIES.filter((category) => after.approvers[category] < before.approvers[category]).map((category) =>
			`${categoryLabel(category)} (one approver)`
		),
		...APPROVER_CATEGORIES.filter((category) => after.requesterMayApprove[category] && !before.requesterMayApprove[category]).map((category) =>
			`${categoryLabel(category)} (the requester's person may approve)`
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
	return a.deployRequestCommits === b.deployRequestCommits && a.requestTtlHours === b.requestTtlHours
		&& APPROVER_CATEGORIES.every((category) =>
			a.approvers[category] === b.approvers[category] && a.requesterMayApprove[category] === b.requesterMayApprove[category]
		)
}

/** The preset a choice is, if any. */
export function presetOf(policy: ApprovalPolicy, settings: ApprovalSettings): (typeof PRESETS)[number]['name'] | null {
	return PRESETS.find((preset) =>
		POLICY_CATEGORIES.every((category) => preset.policy[category] === policy[category]) && sameSettings(preset.settings, settings)
	)?.name ?? null
}

/** A number of hours a request waits, or null for one outside `requestTtlHours`'s bounds. */
export function requestTtl(text: string): number | null {
	const hours = Number(text)
	return Number.isInteger(hours) && hours >= REQUEST_TTL_HOURS.min && hours <= REQUEST_TTL_HOURS.max ? hours : null
}

/** The settings in the console's words, for a reader who cannot change them. */
export function settingsSummary(settings: ApprovalSettings): string {
	const two = APPROVER_CATEGORIES.filter((category) => settings.approvers[category] === 2).map(categoryLabel)
	const others = APPROVER_CATEGORIES.filter((category) => !settings.requesterMayApprove[category]).map(categoryLabel)
	return [
		settings.deployRequestCommits === 'merged' ? 'An agent asks to deploy merged commits only.' : 'An agent may ask to deploy any commit.',
		`A request waits ${settings.requestTtlHours} h for a decision.`,
		...(two.length === 0 ? [] : [`Two people decide: ${two.join(', ')}.`]),
		...(others.length === 0 ? [] : [`Someone other than the requester's person decides: ${others.join(', ')}.`]),
	].join(' ')
}

/** Whether a run's change waits for a person under the categories it was classified under (ADR-0083 §3). */
export function changeWaits(approval: Pick<ApprovalDto, 'changes' | 'categories'>): boolean {
	return gate({ lines: approval.changes }, policyFromCategories(approval.categories)).kind !== 'pass'
}

/** The categories whose mode is not `off`, in the console's order, for a reader who cannot change them. */
export function waitingSummary(policy: ApprovalPolicy): string {
	const named = (mode: ApprovalMode) =>
		APPROVAL_CATEGORY_GROUPS.flatMap((group) => group.options).filter((option) => policy[option.category] === mode).map((option) => option.label)
	const parts = [
		...(named('plan').length > 0 ? [`a plan or a person: ${named('plan').join(', ')}`] : []),
		...(named('person').length > 0 ? [`a person: ${named('person').join(', ')}`] : []),
		...(named('refuse').length > 0 ? [`refused to an agent: ${named('refuse').join(', ')}`] : []),
	]
	return parts.length === 0 ? 'Nothing waits.' : `Waits for ${parts.join('; ')}.`
}

/** The deploys of one environment that wait for a person; turning approvals off decides none of them. */
export function parkedRunsAt(approvals: readonly ApprovalDto[], appId: string, env: string): ApprovalDto[] {
	return approvals.filter((approval) => approval.run.appId === appId && approval.run.env === env)
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
		? `It was asked for on your behalf, and this environment lets someone other than the requester's person approve it. You may refuse it.`
		: `A service key asked for this ${item}, and this environment lets only someone other than the key's issuer approve it, whom Control cannot know: `
			+ 'nobody can approve it. You may refuse it.'
}
