// Operations' two service contracts (ADR-0022 "Installation entries"): `operationsApp` serves them, and the public
// one is what Operations' proxy decides from on both providers.
//
// This module stays free of `@fabrika/provider-cloudflare` and of the rest of this package: the package relaxes two
// strict flags for oblaka, and strict consumers (the platform template generator, the local stack) import this file.

import { defineServiceContract } from '@fabrika/app/service'
import { OPERATIONS_APP_ID, OPERATIONS_RELEASE_RECONCILE_PATH, OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract'

/**
 * The public hostname's table, which its proxy decides from. Both rows authenticate themselves: ingest by the
 * source's Sentry key, the upload by the release's upload credential, which the proxy forwards as `Authorization`.
 */
export const OPERATIONS_PUBLIC_SERVICE = defineServiceContract(OPERATIONS_APP_ID, (s) => ({
	endpoints: {
		'ingest': s.protocol('*', '/api/:projectId/envelope/'),
		'source-map-upload': s.protocol('*', OPERATIONS_SOURCE_MAP_UPLOAD_PATH),
	},
	reservedPrefixes: [],
}))

/**
 * Every other surface, reached only over the private network (`FABRIKA_OPERATIONS_URL`, the `OPERATIONS` binding)
 * and never published to a proxy. `rpc` is Control's operator gateway: it arrives with the console's own
 * `X-Fabrika-Endpoint`, so it is a `protocol` row, authenticated by the injected token and authorized per procedure.
 * The reconcile rows check Control's sync key.
 */
export const OPERATIONS_PRIVATE_SERVICE = defineServiceContract(OPERATIONS_APP_ID, (s) => ({
	endpoints: {
		'health': s.health('*', '/healthz'),
		'rpc': s.protocol('POST', '/api/rpc'),
		'catalog-reconcile': s.protocol('*', '/private/catalog/reconcile'),
		'release-reconcile': s.protocol('*', OPERATIONS_RELEASE_RECONCILE_PATH),
	},
	reservedPrefixes: [],
}))
