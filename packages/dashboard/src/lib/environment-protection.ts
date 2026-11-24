import { RpcError } from '@fabrika/app'
import { type AppEnvDto, type ApprovalCategory, type ApprovalDto, DEFAULT_APPROVAL_CATEGORIES } from '@fabrika/control-contract'
import type { createControlClient } from './api'

type ControlClient = ReturnType<typeof createControlClient>

/** Turning approvals off waits for an explicit confirmation; turning them on applies at once. */
export type ProtectionToggle = 'confirm' | 'apply'

export function protectionToggle(next: boolean): ProtectionToggle {
	return next ? 'apply' : 'confirm'
}

/**
 * Control's `apps.environments.protect`: `access.approve` from a person in the console, audited (ADR-0050 §4). With
 * `categories`, also the kinds of change that wait (ADR-0083); without, the stored choice stays.
 */
export function setEnvironmentProtection(
	client: ControlClient,
	appId: string,
	env: string,
	value: boolean,
	categories?: readonly ApprovalCategory[],
): Promise<AppEnvDto> {
	return client.apps.environments.protect({ appId, env, protected: value, ...(categories === undefined ? {} : { categories: [...categories] }) })
}

export interface CategoryOption {
	readonly category: ApprovalCategory
	readonly label: string
	readonly hint: string
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
]

export function categoryLabel(category: ApprovalCategory): string {
	return APPROVAL_CATEGORY_GROUPS.flatMap((group) => group.options).find((option) => option.category === category)?.label ?? category
}

export function isDefaultCategory(category: ApprovalCategory): boolean {
	return DEFAULT_APPROVAL_CATEGORIES.includes(category)
}

/** Saving fewer categories than are chosen waits for an explicit confirmation, as turning approvals off does. */
export function categoryChange(before: readonly ApprovalCategory[], after: readonly ApprovalCategory[]): ProtectionToggle {
	return before.some((category) => !after.includes(category)) ? 'confirm' : 'apply'
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
