import type { IamRpc } from '@fabrika/auth'

export interface Env {
	// The IAM Worker, reached over a service binding (oblaka `ServiceReference('propustka-worker')`).
	// Typed as the `IamRpc` contract re-exported by the SDK — the app needs no dependency on the
	// worker package itself.
	IAM: IamRpc
	// IAM's origin — the `iss` the SDK verifies every token against, and the JWKS source.
	FABRIKA_IAM_ISSUER?: string
}

export const readIamIssuer = (env: Pick<Env, 'FABRIKA_IAM_ISSUER'>): string => {
	const issuer = env.FABRIKA_IAM_ISSUER
	if (issuer === undefined || issuer === '') {
		throw new Error('FABRIKA_IAM_ISSUER is required')
	}
	return issuer
}
