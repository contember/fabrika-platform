// Test callers: a principal of the test IAM with the permissions its grants resolve to, as IAM resolves them, and
// the credential it presents.

import type { PermissionEntry, PrincipalAffiliation } from '@fabrika/auth-core'
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
	/** A human's address (`ctx.principal.email`), normalized as IAM stores it. Only a human has one. */
	readonly email?: string
	/**
	 * Defaults to `internal`. An `external` human holds only roles the contract declares `external`, as IAM resolves it
	 * (ADR-0051); the kit refuses any other grant for one.
	 */
	readonly affiliation?: PrincipalAffiliation
	/**
	 * An operator disabled the principal in IAM: a member directory lists and finds it with `disabled: true`, and the kit's
	 * IAM signs no token for its session or key, so its requests are refused as IAM refuses a disabled principal's.
	 */
	readonly disabled?: boolean
	/**
	 * When the person last signed in to the application (unix seconds), as IAM records it at the handoff; absent, never.
	 * A member directory answers it to a holder of `members.manage` only. Only a human signs in.
	 */
	readonly lastSignInAt?: number
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

interface TestCallerCredential {
	/** The principal id, or the share key's credential id for a link. */
	readonly id: string
	/** `internal` for every caller but an `external` human. */
	readonly affiliation: PrincipalAffiliation
	/** `true` for a principal an operator disabled; `false` for every other caller, a link holder included. */
	readonly disabled: boolean
	/** A human's last sign-in to the application (`TestCallerOptions.lastSignInAt`); `null` for one that never did and every other caller. */
	readonly lastSignInAt: number | null
	readonly perms: readonly PermissionEntry[]
	/** The `px_` key a key caller presents as a bearer; `null` for a session. */
	readonly key: string | null
	/** The `Cookie` header a signed-in browser sends; `null` for a key caller. */
	readonly cookie: string | null
}

/** A person, a script or another application's connector: a principal with a label. */
export interface LabelledTestCaller extends TestCallerCredential {
	readonly kind: Exclude<TestCallerKind, 'link'>
	/** The consuming application of an `app` caller, `null` for every other kind. */
	readonly app: string | null
	readonly link: null
	readonly label: string
	/** A human's normalized address, which its token carries; `null` for a script and a connector. */
	readonly email: string | null
}

/** A person, whose token carries its address: `ctx.principal.email` of its requests. */
export interface PersonTestCaller extends LabelledTestCaller {
	readonly kind: 'human'
	readonly email: string
}

/** The holder of a share link: an anonymous key, which carries no label. */
export interface LinkTestCaller extends TestCallerCredential {
	readonly kind: 'link'
	readonly app: null
	/** The link mount and chain the key is bound to; `null` for a key bound to nothing. */
	readonly link: TestLink | null
	readonly label: null
	readonly email: null
}

export type TestCaller = LabelledTestCaller | LinkTestCaller

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
