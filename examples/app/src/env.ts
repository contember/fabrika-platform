import type { IamRpc } from '@fabrika/auth'
import { environmentAliases } from '@fabrika/platform'

export interface Env {
	// The IAM Worker, reached over a service binding (oblaka `ServiceReference('propustka-worker')`).
	// Typed as the `IamRpc` contract re-exported by the SDK — the app needs no dependency on the
	// worker package itself.
	IAM: IamRpc
	// Dev flag: in real apps, select `FakeIamClient` when this is set so `wrangler dev` needs no
	// Access and no IAM Worker. This example always uses the real binding to exercise the RPC path.
	DEV: string
	// IAM's origin — the base for login redirects and the `iss`/JWKS the SDK verifies.
	FABRIKA_IAM_ISSUER?: string
	/** @deprecated Use FABRIKA_IAM_ISSUER. */
	PROPUSTKA_ISSUER?: string
}

export const readIamIssuer = (env: Pick<Env, 'FABRIKA_IAM_ISSUER' | 'PROPUSTKA_ISSUER'>): string => {
	const issuer = environmentAliases.read(env, { canonical: 'FABRIKA_IAM_ISSUER', legacy: 'PROPUSTKA_ISSUER' })
	if (issuer === undefined || issuer === '') {
		throw new Error('FABRIKA_IAM_ISSUER is required')
	}
	return issuer
}
