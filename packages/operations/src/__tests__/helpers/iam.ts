import type { IamRpc } from '@fabrika/auth-core'
import { createOperationsIam } from '../../auth.js'

export const TEST_ISSUER = 'https://iam.example.test'

/**
 * An `IamRpc` binding that publishes an empty key set and decides every other operation negatively.
 *
 * `@fabrika/auth` has no local mode — `createIam` requires the binding and the issuer everywhere — so
 * a test that only needs Operations to BOOT still supplies both. A caller is authorized by a real
 * token (see `http-isolation.test.ts`); with no key published, none verifies, which is the point for
 * a suite that asserts unauthenticated behaviour.
 */
export const emptyIamBinding: IamRpc = {
	mintToken: () => Promise.resolve({ ok: false, reason: 'no_session' }),
	mintFromKey: () => Promise.resolve({ ok: false, reason: 'invalid_key' }),
	issueKey: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	issueJwt: () => Promise.resolve({ ok: false, reason: 'not_allowed' }),
	getJwks: () => Promise.resolve({ keys: [] }),
	audit: () => Promise.resolve(),
	listPrincipals: () => Promise.resolve({ ok: true, principals: [] }),
	revokeKey: () => Promise.resolve({ ok: false, reason: 'not_found' }),
}

export const testOperationsIam = () => createOperationsIam({ IAM: emptyIamBinding, FABRIKA_IAM_URL: TEST_ISSUER })
