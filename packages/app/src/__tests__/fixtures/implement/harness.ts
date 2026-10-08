// Signs tokens the way IAM does and sends requests the way the proxy forwards them, so the tests drive `boot`'s
// real pipeline: the shared verifier, the endpoint table and the handlers.

import { compileContract } from '@fabrika/app/contract'
import {
	boot,
	type BootOptions,
	type CapturedEnvironment,
	type ContractApp,
	type ContractImplementation,
	type IamKeySource,
	type SpaAssets,
} from '@fabrika/app/implement'
import {
	buildAccessClaims,
	compileEndpointTable,
	contractDigest,
	ENDPOINT_HEADER,
	FABRIKA_CONTRACT_DIGEST,
	formatEndpointHeader,
	type Jwks,
	type PermissionEntry,
	planEndpoint,
	PROXY_TOKEN_HEADER,
	rawRequestTarget,
	requirementDigest,
} from '@fabrika/auth-core'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

export const ISSUER = 'https://iam.test'
/** The token audience: the IAM id of the application in this environment. */
export const APP_ID = 'notes@prod'
export const ORIGIN = 'https://notes.test'

const { publicKey, privateKey } = await generateKeyPair('ES256')
const exported = await exportJWK(publicKey)
const JWKS: Jwks = { keys: [{ kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y, kid: 'k1', alg: 'ES256', use: 'sig' }] }

export const keySource: IamKeySource = { getJwks: () => Promise.resolve(JWKS) }

export const unreachableIam: IamKeySource = { getJwks: () => Promise.reject(new Error('IAM is down')) }

export const FRAMEWORK_ENV = { FABRIKA_IAM_APP_ID: APP_ID, FABRIKA_IAM_ISSUER: ISSUER }

function artifactOf(app: ContractImplementation) {
	return compileContract(app.contract, app.database?.tables ?? {})
}

/** The framework variables a deploy of `app` gets: `FRAMEWORK_ENV` plus the digest of the contract it was approved with. */
export function frameworkEnvFor(app: ContractImplementation): Record<string, string> {
	return { ...FRAMEWORK_ENV, [FABRIKA_CONTRACT_DIGEST]: contractDigest(artifactOf(app)) }
}

/**
 * `X-Fabrika-Endpoint` as the proxy sets it: the endpoint its table selects for the request, with the digest of the
 * rules it applied. `null` where the proxy selects nothing.
 */
export function endpointHeaderFor(app: ContractImplementation, method: string, path: string): string | null {
	const plan = planEndpoint(compileEndpointTable(artifactOf(app)), method, path)
	return plan.outcome === 'endpoint' ? formatEndpointHeader(plan.endpoint.id, requirementDigest(plan.endpoint)) : null
}

/** What `captureEnvironment` would return for `variables`, without scrubbing this test process's environment. */
export function environment(variables: Readonly<Record<string, unknown>>): CapturedEnvironment {
	const entries = Object.entries(variables)
	return {
		framework: Object.fromEntries(entries.flatMap(([name, value]) => name.startsWith('FABRIKA_') && typeof value === 'string' ? [[name, value]] : [])),
		application: Object.fromEntries(entries.filter(([name]) => !name.startsWith('FABRIKA_'))),
	}
}

/** Runs `work`, then puts back every `FABRIKA_*` variable it scrubbed: the test backends travel under that prefix. */
export async function keepingProcessEnvironment<T>(work: () => Promise<T>): Promise<T> {
	const saved = Object.entries(process.env).filter(([name]) => name.startsWith('FABRIKA_'))
	try {
		return await work()
	} finally {
		for (const [name, value] of saved) {
			process.env[name] = value
		}
	}
}

/** Answers every SPA request with the mount's directory and the path, and a cache header the policy must replace. */
export const echoAssets: SpaAssets = {
	serve: (mount, request) =>
		Promise.resolve(new Response(`${mount.dir} ${new URL(request.url).pathname}`, { headers: { 'Cache-Control': 'max-age=3600' } })),
}

/** A grant of `action`, globally or in one scope value. */
export function grant(action: string, scope?: { readonly type: string; readonly value: string }): PermissionEntry {
	return { action, scope: scope ?? null, source: 'grant' }
}

export type TokenKind = 'user' | 'service' | 'link'

export async function token(kind: TokenKind, perms: PermissionEntry[], audience = APP_ID): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const claims = buildAccessClaims({
		iss: ISSUER,
		app: audience,
		subject: kind === 'link' ? 'credential-1' : `${kind}-1`,
		...(kind === 'link' ? {} : { type: kind }),
		label: kind === 'link' ? null : `${kind}@notes.test`,
		permissions: perms,
		issuedAt: now - 10,
		expiresAt: now + 300,
	})
	return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).sign(privateKey)
}

/** Boots `app` and puts it behind what the proxy adds: the endpoint header, unless the request already carries one. */
export function bootApp(app: ContractImplementation, options: Partial<BootOptions> = {}): ContractApp {
	const runtime = boot(app, { environment: environment(frameworkEnvFor(app)), iam: keySource, assets: echoAssets, ...options })
	return {
		fetch: (request) => {
			const header = endpointHeaderFor(app, request.method, rawRequestTarget(request.url).pathname)
			if (header === null || request.headers.has(ENDPOINT_HEADER)) {
				return runtime.fetch(request)
			}
			const headers = new Headers(request.headers)
			headers.set(ENDPOINT_HEADER, header)
			return runtime.fetch(new Request(request, { headers }))
		},
	}
}

export interface Sent {
	readonly status: number
	readonly headers: Headers
	readonly body: unknown
}

export interface SendOptions {
	readonly token?: string
	readonly body?: unknown
	readonly method?: string
	/** Defaults to a same-origin browser request with a JSON body. */
	readonly headers?: Record<string, string>
}

export async function send(app: ContractApp, path: string, options: SendOptions = {}): Promise<Sent> {
	const method = options.method ?? (options.body === undefined ? 'GET' : 'POST')
	const headers = new Headers(options.headers ?? { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' })
	if (options.token !== undefined) {
		headers.set(PROXY_TOKEN_HEADER, options.token)
	}
	const body = options.body === undefined ? null : JSON.stringify(options.body)
	const response = await app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }))
	const text = await response.text()
	let parsed: unknown = text
	try {
		parsed = JSON.parse(text)
	} catch {
		// A non-JSON answer (an SPA file) stays text.
	}
	return { status: response.status, headers: response.headers, body: parsed }
}

/** `{ result }` of a 200, or the test fails with the error envelope. */
export function resultOf(sent: Sent): unknown {
	if (sent.status !== 200 || typeof sent.body !== 'object' || sent.body === null || !('result' in sent.body)) {
		throw new Error(`expected a result, got ${sent.status} ${JSON.stringify(sent.body)}`)
	}
	return sent.body.result
}

/** The `type` of an error envelope. */
export function errorType(sent: Sent): unknown {
	const body = sent.body
	if (typeof body !== 'object' || body === null || !('error' in body) || typeof body.error !== 'object' || body.error === null) {
		return undefined
	}
	return 'type' in body.error ? body.error.type : undefined
}
