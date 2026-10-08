import type { IamBinding } from '@fabrika/auth'

export interface Env {
	// The IAM Worker's application entrypoint, reached over a service binding (`iamServiceReference()`).
	// Typed as the SDK's `IamBinding`, the part of the `IamRpc` contract that entrypoint serves the SDK —
	// the app needs no dependency on the worker package itself.
	IAM: IamBinding
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
