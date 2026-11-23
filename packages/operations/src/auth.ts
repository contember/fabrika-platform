import { createIam, type Iam, type IamEnv } from '@fabrika/auth'

/**
 * The audience Operations accepts, which is the id of the app whose proxy fronts the surface that
 * token arrives on — and that is the CONSOLE, not `OPERATIONS_APP_ID`.
 *
 * The Operations HOSTNAME serves only its two self-authenticating `protocol` rows (`OPERATIONS_PUBLIC_SERVICE`
 * in `service.ts`), so its own proxy mints nothing. The operator surface is reached over the private network through control's
 * transport-only gateway, behind the console table's `operations-rpc` row — so the token this
 * SDK verifies was minted by the CONSOLE's proxy and carries the console's audience and the caller's
 * permissions in the CONSOLE's app.
 *
 * Moving it to `OPERATIONS_APP_ID` therefore needs the operator surface to move to the Operations host
 * first, which is not a rename: since ADR-0023 a browser's app session is host-only and app-bound, so
 * a console holding a `vozka` session cannot obtain an `operations` token at all. See
 * [backlog 54](../../../docs/backlog/54-give-operations-its-own-proxy-app-identity.md).
 *
 * Verification only, in every environment: the proxy in front of whichever surface the request arrived
 * on injects the access token, and this SDK re-verifies it against IAM's JWKS. There is no local mode —
 * the synthetic dev personas this used to carry were a second authentication model, and the local stack
 * now runs the real proxy and the real IAM instead.
 */
export const OPERATIONS_AUTH_APP_ID = 'vozka'

/** The variable naming the console's Operations RPC as an OAuth resource; set only where the installation serves OAuth. */
export const OPERATIONS_OAUTH_RESOURCE_VARIABLE = 'FABRIKA_OPERATIONS_OAUTH_RESOURCE'

/**
 * With `oauthResource`, the command-line client's token for the console's Operations RPC is accepted beside the console's
 * native tokens. The console's proxy binds such a token to that one row, and its gateway forwards it here unchanged.
 */
export function createOperationsIam(env: IamEnv, oauthResource?: string): Iam {
	return createIam(env, { appId: OPERATIONS_AUTH_APP_ID, ...(oauthResource === undefined ? {} : { oauthResource }) })
}
