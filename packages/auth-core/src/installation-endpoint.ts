// The endpoint forms only an installation service's table may use (ADR-0022 "Installation entries"). Types only,
// like the contract artifact: each reader parses them, and no application contract can declare them.

import type { BodyAdmission, Caller, EndpointMethod } from './contract'

/** Any method. The ambiguity check treats it as overlapping every method of the same path shape. */
export const ANY_METHOD = '*'

export type InstallationEndpointMethod = EndpointMethod | typeof ANY_METHOD

/** The caller an OAuth resource token presents. Only an installation row may admit it. */
export const OAUTH_CALLER = 'oauth'

/** Every caller a verified token can present: an application caller, or `oauth`. */
export type TokenCaller = Caller | typeof OAUTH_CALLER

export type InstallationCaller = 'human' | 'machine' | typeof OAUTH_CALLER

/** `service` verifies a credential; `protocol` and `health` are anonymous, and `protocol` keeps `Authorization`. */
export type InstallationEndpointKind = 'service' | 'protocol' | 'health'

/** The caller kind must be one of the row's callers; no permission is needed. */
export interface AuthenticatedRequirement {
	readonly kind: 'authenticated'
}

/** What a row that admits `oauth` requires of an OAuth resource token: every one of these scopes. */
export interface OAuthEndpointScopes {
	readonly scopes: readonly string[]
}

interface InstallationEndpointBase {
	readonly id: string
	readonly method: InstallationEndpointMethod
	/** The same pattern syntax as an application endpoint's path. */
	readonly path: string
	readonly admission: BodyAdmission | null
}

export interface InstallationCredentialedEndpoint extends InstallationEndpointBase {
	readonly kind: 'service'
	readonly callers: readonly [InstallationCaller, ...InstallationCaller[]]
	readonly requirement: AuthenticatedRequirement
	/** Present exactly when `callers` holds `oauth`. */
	readonly oauth: OAuthEndpointScopes | null
}

export interface InstallationAnonymousEndpoint extends InstallationEndpointBase {
	readonly kind: 'protocol' | 'health'
	readonly callers: readonly []
	readonly requirement: null
	readonly oauth: null
}

export type InstallationEndpointRow = InstallationCredentialedEndpoint | InstallationAnonymousEndpoint

/** An installation service's endpoint table: what `planEndpoint` selects from, with the installation forms. */
export interface InstallationEndpointTable {
	readonly endpoints: readonly InstallationEndpointRow[]
	readonly reservedPrefixes: readonly string[]
}
