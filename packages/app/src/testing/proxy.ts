// The proxy's decision, for the test kit: whether a request reaches the application, and as whom. A test double of
// the enforcement point, never one: it runs only in front of a test kit's in-process application.

import { type Caller, compileEndpointTable, type ContractArtifact, type CredentialedEndpoint, planEndpoint, satisfies } from '@fabrika/auth-core'
import type { TestCaller } from './caller'

/** The credential a request presents, resolved by the test IAM. `caller` is `null` when IAM knows no such credential. */
export type PresentedCredential =
	| { readonly via: 'key'; readonly caller: TestCaller | null }
	| { readonly via: 'session'; readonly caller: TestCaller | null }

/** What the proxy reads to decide: the method, the raw path and the credential. Nothing the client asserts. */
export interface ProxyRequest {
	readonly method: string
	readonly rawPath: string
	readonly credential: PresentedCredential | null
}

export type ProxyVerdict =
	/** Forward the request; with a caller, the kit mints its token and injects it. */
	| { readonly outcome: 'forward'; readonly caller: TestCaller | null }
	| { readonly outcome: 'refuse'; readonly status: 400 | 401 | 403; readonly reason: string }
	/** A request without a session to an endpoint a human may call: the proxy answers with the login URL. */
	| { readonly outcome: 'login' }

/**
 * The seam the kit decides through. `endpointDecision` is the default; a decision over the gates
 * `gatesFromContract` generates plugs in here, through `TestKitOptions.proxy`.
 */
export type ProxyDecision = (request: ProxyRequest) => ProxyVerdict

function checked(caller: TestCaller, row: CredentialedEndpoint): ProxyVerdict {
	return satisfies(row.requirement, caller.perms)
		? { outcome: 'forward', caller }
		: { outcome: 'refuse', status: 403, reason: `'${row.id}' needs a permission the caller does not hold` }
}

/**
 * The decision of ADR-0022 over an endpoint table: canonical path, `planEndpoint`, then a `px_` key (terminal) or the
 * session, the caller kind, and the requirement. An anonymous endpoint forwards without a caller. Admission is left
 * to the application, which checks it again either way.
 */
export function endpointDecision(artifact: ContractArtifact): ProxyDecision {
	const table = compileEndpointTable(artifact)
	return ({ method, rawPath, credential }) => {
		const plan = planEndpoint(table, method, rawPath)
		if (plan.outcome === 'non-canonical') {
			return { outcome: 'refuse', status: 400, reason: 'the path is not canonical' }
		}
		if (plan.outcome === 'no-endpoint') {
			return { outcome: 'refuse', status: 403, reason: `no endpoint serves ${method} ${rawPath}` }
		}
		const row = plan.endpoint
		if (row.requirement === null) {
			return { outcome: 'forward', caller: null }
		}
		const callers: readonly Caller[] = row.callers
		if (credential?.via === 'key') {
			if (credential.caller === null) {
				return { outcome: 'refuse', status: 401, reason: 'the bearer is not a key the test IAM issued' }
			}
			if (!callers.includes(credential.caller.kind)) {
				return { outcome: 'refuse', status: 403, reason: `a ${credential.caller.kind} key cannot call '${row.id}'` }
			}
			return checked(credential.caller, row)
		}
		if (!callers.includes('human')) {
			return { outcome: 'refuse', status: 401, reason: `'${row.id}' takes a key, and the request carries none` }
		}
		if (credential === null || credential.caller === null) {
			return { outcome: 'login' }
		}
		return checked(credential.caller, row)
	}
}
