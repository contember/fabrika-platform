import { createIam, type Iam, type IamEnv } from '@fabrika/auth'

export const OPERATIONS_AUTH_APP_ID = 'vozka'

/**
 * Operations authenticates as the same Fabrika IAM application as the control console.
 *
 * Verification only, in every environment: the proxy matches `OPERATOR_GATES` and injects the access
 * token, and this SDK re-verifies it against IAM's JWKS. There is no local mode — the synthetic dev
 * personas this used to carry were a second authentication model, and the local stack now runs the
 * real proxy and the real IAM instead.
 */
export function createOperationsIam(env: IamEnv): Iam {
	return createIam(env, { appId: OPERATIONS_AUTH_APP_ID })
}
