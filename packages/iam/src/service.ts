// IAM's service contract (ADR-0022 "Installation entries"): `createIamApp` serves it, and on Zerops the platform proxy
// decides from it. IAM's Cloudflare Worker stays unfronted; there the table is only its router.
//
// Every row is `protocol`: IAM authenticates each surface itself (its login, the JWKS, OAuth, `/admin/*` bearer-only,
// the shared secrets of `/rpc/*` and `/auth/mint/*`, an application's own key on `/membership/*`), so the proxy reads
// no credential here. This module imports only `@fabrika/app/service`, so strict consumers can import it without IAM's
// runtime.

import { defineServiceContract } from '@fabrika/app/service'

/** The composition switches of `IamAppOptions`; a switched-off surface has no row, so neither side serves it. */
export interface IamServiceOptions {
	/** Process liveness (`health`). */
	readonly health: boolean
	/** The management transport `/rpc/*` (a non-empty `rpcKey`). */
	readonly managementRpc: boolean
	/** The proxy's mint transport `/auth/mint/*` (a non-empty `proxyKey`). */
	readonly mintRpc: boolean
	/** The applications' membership transport `/membership/<method>` (`membershipTransport`). */
	readonly membershipTransport: boolean
}

export function iamServiceContract(options: IamServiceOptions) {
	return defineServiceContract('iam', (s) => {
		const mint = (path: string) => options.mintRpc ? s.protocol('*', path) : null
		return {
			endpoints: {
				'health': options.health ? s.health('*', '/healthz') : null,
				'jwks': s.protocol('*', '/.well-known/jwks.json'),
				'oauth-metadata': s.protocol('*', '/.well-known/oauth-authorization-server'),
				'oauth': s.protocol('*', '/oauth/*'),
				'auth-root': s.protocol('*', '/auth'),
				'auth': s.protocol('*', '/auth/*'),
				'mint-session': mint('/auth/mint/session'),
				'mint-key': mint('/auth/mint/key'),
				'mint-exchange': mint('/auth/mint/exchange'),
				'mint-delegation': mint('/auth/mint/delegation'),
				'admin-rpc': s.protocol('POST', '/admin/rpc'),
				'admin-root': s.protocol('*', '/admin'),
				'admin': s.protocol('*', '/admin/*'),
				// Authenticated by the calling application's own transport key, per environment.
				'membership': options.membershipTransport ? s.protocol('*', '/membership/*') : null,
				'rpc-root': options.managementRpc ? s.protocol('*', '/rpc') : null,
				'rpc': options.managementRpc ? s.protocol('*', '/rpc/*') : null,
			},
			// A switched-off transport's paths reach no broader row: `/auth/mint/…` never falls to `/auth/*`.
			reservedPrefixes: ['/auth/mint', '/rpc'],
		}
	})
}

/**
 * What an installation's IAM process mounts, and so the table the platform proxy publishes: the Zerops topology always
 * writes both transport keys. Zerops applications reach `/membership/*` and an operator's `fabrika control key issue`
 * reaches `/rpc/*` at the public issuer; namespace proxies mint over `/auth/mint/*` there too.
 */
export const IAM_INSTALLATION_SERVICE_OPTIONS: IamServiceOptions = { health: true, managementRpc: true, mintRpc: true, membershipTransport: true }

export type IamEndpointId = ReturnType<typeof iamServiceContract>['endpoints'][number]['id']
