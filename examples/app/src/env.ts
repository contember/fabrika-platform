import type { IamRpc } from '@fabrika/auth'
import { environmentAliases } from '@fabrika/platform'

export interface Env {
	// The IAM Worker, reached over a service binding (oblaka `ServiceReference('propustka-worker')`).
	// Typed as the `IamRpc` contract re-exported by the SDK — the app needs no dependency on the
	// worker package itself.
	IAM: IamRpc
	// IAM's origin — the `iss` the SDK verifies every token against, and the JWKS source.
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
