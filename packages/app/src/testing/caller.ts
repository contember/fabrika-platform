// Test callers: a principal of the test IAM with the permissions its grants resolve to, as IAM resolves them, and
// the credential it presents.

import type { PermissionEntry } from '@fabrika/auth-core'
import type { ActionOf, AnyContract, DimensionOf, RoleOf } from '../contract/define'

/** `app` is the connector of another application: its key reaches only the exports that application consumes. */
export type TestCallerKind = 'human' | 'machine' | 'link' | 'app'

export interface TestScope<D extends string = string> {
	readonly type: D
	readonly value: string
}

/** An action, or a role whose actions IAM grants together; without a scope it is global. */
export type TestGrant<C> =
	| { readonly action: ActionOf<C>; readonly scope?: TestScope<DimensionOf<C>> }
	| { readonly role: RoleOf<C>; readonly scope?: TestScope<DimensionOf<C>> }

export interface TestCallerOptions {
	/** Defaults to `human`. */
	readonly kind?: TestCallerKind
	/** How a human signs in: the IAM session (default) or a `px_` key bound to the person. Other kinds use a key. */
	readonly via?: 'session' | 'key'
	readonly id?: string
	readonly label?: string
	/** The consuming application's id, for an `app` caller. */
	readonly app?: string
	/**
	 * What a `link` caller's key is bound to: the link mount, and the object first, then each value containing it. A link
	 * caller without one holds a key bound to nothing, which no procedure admits.
	 */
	readonly link?: TestLink
}

export interface TestLink {
	readonly mount: string
	readonly chain: readonly TestScope[]
}

export interface TestCaller {
	readonly kind: TestCallerKind
	/** The consuming application of an `app` caller, `null` for every other kind. */
	readonly app: string | null
	/** The link mount and chain a `link` caller's key is bound to; `null` for every other kind. */
	readonly link: TestLink | null
	/** The principal id, or the share key's credential id for a link. */
	readonly id: string
	readonly label: string | null
	readonly perms: readonly PermissionEntry[]
	/** The `px_` key a key caller presents as a bearer; `null` for a session. */
	readonly key: string | null
	/** The `Cookie` header a signed-in browser sends; `null` for a key caller. */
	readonly cookie: string | null
}

/** The permissions `grants` resolve to: a role becomes each of its actions in the role's scope. */
export function resolveGrants<C extends AnyContract>(contract: C, grants: readonly TestGrant<C>[]): PermissionEntry[] {
	const { actions, roles } = contract.vocabulary
	const scopeOf = (scope: TestScope | undefined) => (scope === undefined ? null : { type: scope.type, value: scope.value })
	return grants.flatMap((grant): PermissionEntry[] => {
		if ('action' in grant) {
			if (!Object.hasOwn(actions, grant.action)) {
				throw new Error(`'${grant.action}' is not an action of the contract`)
			}
			return [{ action: grant.action, scope: scopeOf(grant.scope), source: 'grant' }]
		}
		const role = Object.hasOwn(roles, grant.role) ? roles[grant.role] : undefined
		if (role === undefined) {
			throw new Error(`'${grant.role}' is not a role of the contract`)
		}
		if (role.member !== undefined && grant.scope?.type !== role.member.scope) {
			throw new Error(`'${grant.role}' is a membership role: grant it in one ${role.member.scope} (scope: { type: '${role.member.scope}', value })`)
		}
		return role.grants.map((action) => ({ action, scope: scopeOf(grant.scope), source: 'grant' }))
	})
}
