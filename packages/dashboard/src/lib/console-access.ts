import { type ConsoleAccessDto, CONTROL_ACTIONS } from '@fabrika/control-contract'
import type { IamAdministrationScope } from '@fabrika/iam-contract'
import { OPERATIONS_ACTIONS } from '@fabrika/operations-contract/access'

/** Every page the navigation links to. */
export type NavPage =
	| 'index'
	| 'apps'
	| 'namespaces'
	| 'runs'
	| 'approvals'
	| 'mail'
	| 'settings/source'
	| 'settings/branding'
	| 'settings/passwords'
	| 'access'
	| 'access/users'
	| 'access/credentials'
	| 'access/permissions'
	| 'access/audit'
	| 'operations'
	| 'operations/errors'
	| 'operations/sources'
	| 'operations/releases'
	| 'operations/health'
	| 'people'

/**
 * What the console knows about what its caller may use. A null field is unknown (the service did not answer), and
 * reads as usable, so an outage shows the page that reports it instead of a claim that the caller has no access.
 */
export interface ConsoleCaller {
	readonly access: ConsoleAccessDto | null
	/** What IAM's `me` says the caller administers there; `false` for nothing (ADR-0058). */
	readonly iam: IamAdministrationScope | false | null
	/** IAM lists an application whose own people the caller administers. */
	readonly administersPeople: boolean | null
}

export function holdsGlobally(access: ConsoleAccessDto, action: string): boolean {
	return access.global.includes(action)
}

/** The action in some scope, global included: a page that lists only what the caller may see is usable. */
export function holdsAnywhere(access: ConsoleAccessDto, action: string): boolean {
	return holdsGlobally(access, action) || access.scopes.some((scope) => scope.actions.includes(action))
}

/** The action at an application environment: globally, at the app, or at the environment, as Control checks it. */
export function holdsAt(access: ConsoleAccessDto, action: string, at: { readonly app: string; readonly env: string }): boolean {
	return holdsGlobally(access, action) || access.scopes.some((scope) =>
		scope.actions.includes(action)
		&& ((scope.type === 'app' && scope.value === at.app) || (scope.type === 'environment' && scope.value === at.env))
	)
}

/** The scope values the caller reads runs in, for a caller that holds `deploy.read` only in some. */
export function scopedRunReads(access: ConsoleAccessDto): { apps: string[]; environments: string[] } {
	const held = access.scopes.filter((scope) => scope.actions.includes(CONTROL_ACTIONS.DEPLOY_READ))
	return {
		apps: held.filter((scope) => scope.type === 'app').map((scope) => scope.value),
		environments: held.filter((scope) => scope.type === 'environment').map((scope) => scope.value),
	}
}

/** The application pages list every application, so they need `app.manage` as a global grant. */
export function opensApplications(access: ConsoleAccessDto | null): boolean {
	return access === null || holdsGlobally(access, CONTROL_ACTIONS.APP_MANAGE)
}

/** An environment's data view (ADR-0069) needs `data.read` in some scope; its procedures decide at the environment. */
export function opensDataView(access: ConsoleAccessDto | null): boolean {
	return access === null || holdsAnywhere(access, CONTROL_ACTIONS.DATA_READ)
}

/** Unknown access reads as usable; see `ConsoleCaller`. */
function control(caller: ConsoleCaller, holds: (access: ConsoleAccessDto) => boolean): boolean {
	return caller.access === null || holds(caller.access)
}

/** Each page's rule is what its loader asks for, so a page shown in the navigation loads. */
export function mayOpen(caller: ConsoleCaller, page: NavPage): boolean {
	const { APP_MANAGE, NAMESPACE_MANAGE, DEPLOY_READ, ACCESS_APPROVE, MAIL_READ, SOURCE_CONNECTION_MANAGE } = CONTROL_ACTIONS
	switch (page) {
		case 'index':
			return control(caller, (access) => [APP_MANAGE, NAMESPACE_MANAGE, DEPLOY_READ].every((action) => holdsGlobally(access, action)))
		case 'apps':
			return opensApplications(caller.access)
		case 'namespaces':
			return control(caller, (access) => holdsGlobally(access, NAMESPACE_MANAGE))
		case 'runs':
			return control(caller, (access) => holdsAnywhere(access, DEPLOY_READ))
		case 'approvals':
			return control(caller, (access) => holdsAnywhere(access, ACCESS_APPROVE))
		case 'mail':
			return control(caller, (access) => holdsAnywhere(access, MAIL_READ))
		case 'settings/source':
			return control(caller, (access) => holdsGlobally(access, SOURCE_CONNECTION_MANAGE))
		// IAM keeps the logo and lets only an installation administrator change it (ADR-0066).
		case 'settings/branding':
		// IAM keeps the minimum password length too, under the same rule (ADR-0020).
		case 'settings/passwords':
			return caller.iam === null || (caller.iam !== false && caller.iam.kind === 'installation')
		case 'access/users':
			return caller.iam !== false
		case 'access':
		case 'access/credentials':
		case 'access/permissions':
		case 'access/audit':
			return caller.iam === null || (caller.iam !== false && caller.iam.kind === 'installation')
		case 'operations':
		case 'operations/errors':
		case 'operations/sources':
		case 'operations/releases':
		case 'operations/health':
			return control(caller, (access) => holdsAnywhere(access, OPERATIONS_ACTIONS.READ))
		case 'people':
			return caller.administersPeople !== false
	}
}

/**
 * Whether to offer an action's control: at an application environment when one is named, anywhere otherwise. Unknown
 * access offers it; the procedure decides either way.
 */
export function mayDo(access: ConsoleAccessDto | null, action: string, at?: { readonly app: string; readonly env: string }): boolean {
	if (access === null) return true
	return at === undefined ? holdsAnywhere(access, action) : holdsAt(access, action, at)
}
