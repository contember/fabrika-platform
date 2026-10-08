// The proxy in front of the test kit's application. By default it is today's production decision: proxy-core's
// verify service over the gates `gatesFromContract` generates, composed the way the Cloudflare proxy Worker
// composes it. `endpointsProxy` is ADR-0022's per-endpoint decision, an explicit opt-in for tests written ahead of
// the proxy deciding per endpoint (B2).

import {
	type Caller,
	compileEndpointTable,
	type ContractArtifact,
	type CredentialedEndpoint,
	planEndpoint,
	rawRequestTarget,
	satisfies,
} from '@fabrika/auth-core'
import {
	APP_QUERY_PARAM,
	createVerifyService,
	DEFAULT_VERIFY_PATH,
	FORWARDED_HOST_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_PROTO_HEADER,
	FORWARDED_URI_HEADER,
	type IamGateway,
	PROXY_TOKEN_HEADER,
	REQUEST_ID_HEADER,
} from '@fabrika/proxy-core'
import { gatesFromContract } from '../contract/platform'
import type { TestCaller } from './caller'

/** What the proxy did with a request: answered it itself, or forwarded it with what only the proxy may set. */
export type ProxyOutcome =
	| {
		readonly outcome: 'forward'
		readonly token: string | null
		readonly requestId: string | null
		/** Whether the request's own `Authorization` reaches the application. */
		readonly keepsAuthorization: boolean
	}
	| { readonly outcome: 'answer'; readonly response: Response }

/** What the proxy reads of a request; its headers have already lost every one a client may not assert. */
export interface ProxiedRequest {
	readonly method: string
	readonly url: string
	readonly headers: Headers
}

export type TestProxy = (request: ProxiedRequest) => Promise<ProxyOutcome>

export interface GatesProxyOptions {
	readonly artifact: ContractArtifact
	readonly appId: string
	readonly host: string
	readonly iam: IamGateway
	readonly issuer: string
}

/** Today's proxy: the production verify service, asked the way an enforcement point asks it. */
export function gatesProxy(options: GatesProxyOptions): TestProxy {
	const verify = createVerifyService({
		manifest: { apps: [{ id: options.appId, hosts: [options.host], upstream: 'app', gates: gatesFromContract(options.artifact), scheme: 'https' }] },
		iam: options.iam,
		issuer: options.issuer,
	})
	const verifyUrl = `https://fabrika-proxy.internal${DEFAULT_VERIFY_PATH}?${APP_QUERY_PARAM}=${encodeURIComponent(options.appId)}`
	return async (request) => {
		const headers = new Headers(request.headers)
		const target = rawRequestTarget(request.url)
		headers.set(FORWARDED_METHOD_HEADER, request.method)
		headers.set(FORWARDED_URI_HEADER, `${target.pathname}${target.search}`)
		headers.set(FORWARDED_HOST_HEADER, new URL(request.url).host)
		headers.set(FORWARDED_PROTO_HEADER, 'https')
		const verification = await verify(new Request(verifyUrl, { method: 'GET', headers }))
		if (!verification.ok) {
			return { outcome: 'answer', response: verification }
		}
		return {
			outcome: 'forward',
			token: verification.headers.get(PROXY_TOKEN_HEADER),
			requestId: verification.headers.get(REQUEST_ID_HEADER),
			keepsAuthorization: true,
		}
	}
}

/** The credential a request presents, resolved by the test IAM. `caller` is `null` when IAM knows no such credential. */
export type PresentedCredential =
	| { readonly via: 'key'; readonly caller: TestCaller | null }
	| { readonly via: 'session'; readonly caller: TestCaller | null }

export interface EndpointsProxyOptions {
	readonly artifact: ContractArtifact
	readonly issuer: string
	readonly credentialOf: (headers: Headers) => PresentedCredential | null
	/** The caller's token, or `null` when IAM refuses to sign one that large. */
	readonly mint: (caller: TestCaller) => Promise<string | null>
}

type Verdict =
	| { readonly outcome: 'forward'; readonly caller: TestCaller | null }
	| { readonly outcome: 'refuse'; readonly status: 400 | 401 | 403 }
	| { readonly outcome: 'login' }

const DENY_TEXT: Readonly<Record<400 | 401 | 403, string>> = { 400: 'bad request', 401: 'unauthorized', 403: 'forbidden' }

function checked(caller: TestCaller, row: CredentialedEndpoint): Verdict {
	return satisfies(row.requirement, caller.perms) ? { outcome: 'forward', caller } : { outcome: 'refuse', status: 403 }
}

/**
 * ADR-0022's steps over the endpoint table: canonical path, `planEndpoint` (no endpoint is 403), then a `px_` key
 * (terminal) whose caller kind must be a caller, or the session (401 when `human` is not a caller, the login URL
 * when there is none), and the requirement. An anonymous endpoint forwards without a caller or a credential.
 */
function endpointVerdict(table: ReturnType<typeof compileEndpointTable>, request: ProxiedRequest, credential: PresentedCredential | null): Verdict {
	const rawPath = rawRequestTarget(request.url).pathname
	const plan = planEndpoint(table, request.method, rawPath)
	if (plan.outcome === 'non-canonical') {
		return { outcome: 'refuse', status: 400 }
	}
	if (plan.outcome === 'no-endpoint') {
		return { outcome: 'refuse', status: 403 }
	}
	const row = plan.endpoint
	if (row.requirement === null) {
		return { outcome: 'forward', caller: null }
	}
	const callers: readonly Caller[] = row.callers
	if (credential?.via === 'key') {
		if (credential.caller === null) {
			return { outcome: 'refuse', status: 401 }
		}
		return callers.includes(credential.caller.kind) ? checked(credential.caller, row) : { outcome: 'refuse', status: 403 }
	}
	if (!callers.includes('human')) {
		return { outcome: 'refuse', status: 401 }
	}
	return credential === null || credential.caller === null ? { outcome: 'login' } : checked(credential.caller, row)
}

function textAnswer(status: 400 | 401 | 403): ProxyOutcome {
	return { outcome: 'answer', response: new Response(DENY_TEXT[status], { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }) }
}

/** The per-endpoint decision ADR-0022 describes for contract applications; opt in with `proxy: 'endpoints'`. */
export function endpointsProxy(options: EndpointsProxyOptions): TestProxy {
	const table = compileEndpointTable(options.artifact)
	const loginUrl = `${options.issuer}/auth/login`
	return async (request) => {
		const verdict = endpointVerdict(table, request, options.credentialOf(request.headers))
		if (verdict.outcome === 'refuse') {
			return textAnswer(verdict.status)
		}
		if (verdict.outcome === 'login') {
			const mode = request.headers.get('Sec-Fetch-Mode')
			const response = mode === null || mode === 'navigate'
				? new Response(null, { status: 302, headers: { Location: loginUrl } })
				: Response.json({ error: { type: 'auth', message: 'Authentication required', loginUrl } }, { status: 401 })
			return { outcome: 'answer', response }
		}
		if (verdict.caller === null) {
			return { outcome: 'forward', token: null, requestId: null, keepsAuthorization: false }
		}
		const token = await options.mint(verdict.caller)
		return token === null ? textAnswer(403) : { outcome: 'forward', token, requestId: null, keepsAuthorization: true }
	}
}
