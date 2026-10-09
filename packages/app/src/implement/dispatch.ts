// The per-request pipeline of a contract application (ADR-0012 §5): canonical path and endpoint selection, the
// endpoint the proxy applied (ADR-0022 rule 5), the token, the caller kind, the requirement, admission, strict input, the access form, the handler, output
// projection. The caller-kind, requirement and access checks are authorization; the same-origin and content-type
// checks are admission. Neither evaluates a gate: the proxy has already decided that the request may reach us.

import {
	type AccessForm,
	type CompiledEndpointTable,
	type CredentialedEndpoint,
	ENDPOINT_HEADER,
	type EndpointPlan,
	type EndpointRow,
	parseEndpointHeader,
	type PermissionEntry,
	permits,
	planEndpoint,
	PROXY_SECRET_HEADER,
	PROXY_TOKEN_HEADER,
	rawRequestTarget,
	satisfies,
	scopedValues,
} from '@fabrika/auth-core'
import { type ContainerGrant, MAX_WITHIN_VALUES } from '@fabrika/db/capability'
import type { TokenVerifier } from '@fabrika/jwks'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod/v4'
import type { Schema } from '../contract/define'
import {
	BadRequestError,
	ForbiddenError,
	HttpError,
	isStructuralError,
	jsonResponse,
	NotFoundError,
	toErrorResponse,
	UnauthorizedError,
} from '../errors'
import { FileDownload, fileResponse, withFileTreatment } from '../files/treatment'
import { CapabilityLimitError, CapabilityRefusedError, mintRef, mintWithin, RequestFrame, runInRequest } from './capability'
import { type HeaderPolicy, withHeaderPolicy } from './headers'
import type { ContractDatabase } from './implement'
import { presentedBy, type Principal } from './principal'
import { project, ProjectionRefusedError } from './project'

/** SHA-256 of a proxy secret: 32 bytes whatever the secret's length, as `timingSafeEqual` needs. */
export function proxySecretDigest(secret: string): Uint8Array {
	return createHash('sha256').update(secret).digest()
}

/** Serves the files of an SPA mount. The runtime adapter supplies it: Workers Assets, or the build output on disk. */
export interface SpaAssets {
	serve(mount: { readonly prefix: string; readonly dir: string }, request: Request): Promise<Response>
}

export type ServedEndpoint =
	| {
		readonly kind: 'procedure'
		readonly row: CredentialedEndpoint
		readonly input: Schema | null
		readonly output: Schema
		readonly handler: (args: { readonly input: Readonly<Record<string, unknown>>; readonly ctx: object }) => unknown
	}
	| { readonly kind: 'spa'; readonly row: CredentialedEndpoint; readonly prefix: string; readonly dir: string }
	| { readonly kind: 'health'; readonly row: EndpointRow }
	| {
		/** A file collection's upload or download, served by `src/files` once the access form minted its target. */
		readonly kind: 'file'
		readonly row: CredentialedEndpoint
		readonly serve: (request: Request, target: unknown) => Promise<Response | FileDownload>
	}

export interface RuntimeParts {
	readonly table: CompiledEndpointTable
	readonly endpoints: ReadonlyMap<string, ServedEndpoint>
	/** Endpoint id → `requirementDigest` of its row: what the proxy's `X-Fabrika-Endpoint` must name. */
	readonly digests: ReadonlyMap<string, string>
	readonly verifier: TokenVerifier
	/** The token audience: this application's IAM id in this environment, `<app>@<env>`. */
	readonly audience: string
	/** `proxySecretDigest` of the proxy secret every request must carry; `null` where the hop is a service binding. */
	readonly proxySecretDigest: Uint8Array | null
	readonly policy: HeaderPolicy
	readonly database: ContractDatabase | null
	/** Dimensions a table owns, so `in` and `on` must find the object. */
	readonly ownedDimensions: ReadonlySet<string>
	/** Each dimension's containers, nearest first; a grant on one reaches every value inside it. */
	readonly containers: ReadonlyMap<string, readonly string[]>
	readonly assets: SpaAssets | null
}

interface Caller {
	readonly principal: Principal
	/** The principal id a capability is granted to: the token's subject. */
	readonly subject: string
	readonly perms: PermissionEntry[]
}

interface Access {
	readonly context: Readonly<Record<string, unknown>>
	readonly input: Readonly<Record<string, unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The media type of a `Content-Type` value, without parameters, lower-cased. */
function mediaType(header: string | null): string | null {
	const type = header?.split(';')[0]?.trim().toLowerCase()
	return type === undefined || type === '' ? null : type
}

function describeRequirement(row: CredentialedEndpoint): string {
	return row.requirement.kind === 'member' ? 'a permission in this application' : `'${row.requirement.action}' in some scope`
}

export class ContractRuntime {
	readonly #parts: RuntimeParts

	constructor(parts: RuntimeParts) {
		this.#parts = parts
	}

	/** Every answer of a download endpoint, a denial included, carries the file treatment; every other one the policy. */
	async fetch(request: Request): Promise<Response> {
		const plan = planEndpoint(this.#parts.table, request.method, rawRequestTarget(request.url).pathname)
		const answer = await this.#answer(request, plan)
		if (answer instanceof FileDownload) {
			return fileResponse(answer)
		}
		return plan.outcome === 'endpoint' && plan.endpoint.kind === 'download' ? withFileTreatment(answer) : withHeaderPolicy(answer, this.#parts.policy)
	}

	async #answer(request: Request, plan: EndpointPlan): Promise<Response | FileDownload> {
		let where = 'request'
		try {
			const served = plan.outcome === 'endpoint' ? this.#parts.endpoints.get(plan.endpoint.id) : undefined
			// Before any other answer: a direct dial learns nothing, not even whether its path exists.
			if (served?.kind !== 'health' && !this.#throughProxy(request)) {
				throw new ForbiddenError('This application answers only its proxy')
			}
			if (plan.outcome === 'non-canonical') {
				throw new BadRequestError('The request path is not canonical')
			}
			if (served === undefined) {
				throw new NotFoundError(`No endpoint serves ${request.method} ${rawRequestTarget(request.url).pathname}`)
			}
			where = served.row.id
			this.#checkEndpoint(served, request)
			switch (served.kind) {
				case 'health':
					return jsonResponse({ status: 'ok' }, 200)
				case 'spa': {
					await this.#authorize(served.row, request)
					const assets = this.#parts.assets
					if (assets === null) {
						throw new ServerFault('no asset server serves the SPA')
					}
					return await assets.serve({ prefix: served.prefix, dir: served.dir }, request)
				}
				case 'procedure':
					return await this.#procedure(served, request)
				case 'file':
					return await this.#file(served, request, plan.outcome === 'endpoint' ? plan.params : {})
			}
		} catch (error) {
			return errorResponse(error, where)
		}
	}

	/**
	 * The proxy proves it sent the request with the secret of this application environment (ADR-0022 rule 5). The
	 * fixed-size digests are compared in constant time, so neither the length nor a prefix of the secret leaks.
	 */
	#throughProxy(request: Request): boolean {
		const expected = this.#parts.proxySecretDigest
		if (expected === null) {
			return true
		}
		const presented = request.headers.get(PROXY_SECRET_HEADER) ?? ''
		return presented !== '' && timingSafeEqual(proxySecretDigest(presented), expected)
	}

	/**
	 * The proxy names the endpoint it selected and the digest of the rules it applied. Any disagreement with this
	 * version's own selection or rules is a 503, so no request is served under rules the proxy did not apply. A
	 * health endpoint answers a constant and is what the platform's liveness probe dials directly, so it alone may
	 * arrive without the header.
	 */
	#checkEndpoint(served: ServedEndpoint, request: Request): void {
		const header = request.headers.get(ENDPOINT_HEADER)
		if (header === null && served.kind === 'health') {
			return
		}
		const named = header === null ? null : parseEndpointHeader(header)
		if (named === null) {
			throw new ServerFault(`'${served.row.id}' was reached without the proxy's endpoint decision`, 503)
		}
		if (named.id !== served.row.id || named.digest !== this.#parts.digests.get(served.row.id)) {
			throw new ServerFault(`the proxy applied '${named.id}' with other rules than this version serves '${served.row.id}' with`, 503)
		}
	}

	/** Token, caller kind, requirement, then admission. */
	async #authorize(row: CredentialedEndpoint, request: Request): Promise<Caller> {
		const token = request.headers.get(PROXY_TOKEN_HEADER)?.trim() ?? ''
		if (token === '') {
			throw new UnauthorizedError('This endpoint needs a credential, and the request carries none')
		}
		const verified = await this.#parts.verifier.verify(token, this.#parts.audience)
		if (!verified.ok) {
			if (verified.reason === 'unavailable') {
				throw new ServerFault('the IAM key set could not be fetched; nothing was checked', 503)
			}
			throw new UnauthorizedError('The credential does not verify')
		}
		const presented = presentedBy(verified.claims)
		if (presented === null || !row.callers.includes(presented.caller)) {
			throw new ForbiddenError(`A ${presented?.caller ?? 'resource'} caller cannot call '${row.id}' (callers: ${row.callers.join(', ')})`)
		}
		if (!satisfies(row.requirement, verified.claims.perms)) {
			throw new ForbiddenError(`'${row.id}' needs ${describeRequirement(row)}, and the caller holds none`)
		}
		admit(row, request)
		return { principal: presented.principal, subject: verified.claims.sub, perms: verified.claims.perms }
	}

	async #procedure(served: Extract<ServedEndpoint, { kind: 'procedure' }>, request: Request): Promise<Response> {
		const caller = await this.#authorize(served.row, request)
		const input = await readInput(served, request)
		const frame = new RequestFrame(crypto.randomUUID())
		let result: unknown
		try {
			result = await runInRequest(frame, async () => {
				const access = await this.#access(served.row, caller, input, frame)
				const ctx = Object.freeze({ principal: caller.principal, requestId: frame.id, ...access.context })
				return await served.handler({ input: access.input, ctx })
			})
		} finally {
			frame.end()
		}
		const output = z.safeParse(served.output, projectOutput(served, result))
		if (!output.success) {
			throw new ServerFault(`'${served.row.id}' returned a value its output schema refuses`)
		}
		return jsonResponse({ result: output.data }, 200)
	}

	/** The access form reads its value from the path parameter it names: `:owner` of an upload, `:fileId` of a download. */
	async #file(
		served: Extract<ServedEndpoint, { kind: 'file' }>,
		request: Request,
		params: Readonly<Record<string, string>>,
	): Promise<Response | FileDownload> {
		const caller = await this.#authorize(served.row, request)
		const access = served.row.requirement.kind === 'action' ? served.row.requirement.access : null
		const from = access?.form === 'on' ? access.from : null
		const raw = from === null ? undefined : params[from]
		if (from === null || raw === undefined) {
			throw new ServerFault(`'${served.row.id}' names no path parameter for its access form`)
		}
		const frame = new RequestFrame(crypto.randomUUID())
		try {
			return await runInRequest(frame, async () => {
				const { context } = await this.#access(served.row, caller, { [from]: decodePathParameter(raw) }, frame)
				return await served.serve(request, context['target'])
			})
		} finally {
			frame.end()
		}
	}

	async #access(row: CredentialedEndpoint, caller: Caller, input: Readonly<Record<string, unknown>>, frame: RequestFrame): Promise<Access> {
		if (row.requirement.kind === 'member') {
			return { context: {}, input }
		}
		const { action, access } = row.requirement
		switch (access.form) {
			case 'over': {
				const direct = scopedValues(caller.perms, action, access.dimension)
				if (direct === null) {
					return { context: { within: mintWithin(frame, access.dimension, action, caller.subject, 'all') }, input }
				}
				const held = this.#heldContainers(caller.perms, action, access.dimension)
				if (direct.length === 0 && held.length === 0) {
					throw new ForbiddenError(`The caller holds '${action}' in no ${access.dimension}`)
				}
				return { context: { within: mintWithin(frame, access.dimension, action, caller.subject, direct, held) }, input }
			}
			case 'in': {
				const { value, rest } = takeField(input, access.from)
				const direct = permits(caller.perms, action, { type: access.dimension, value })
				// Without a grant on the value or on a container of its dimension, nothing is read: 403 whether it exists or not.
				if (!direct && this.#heldContainers(caller.perms, action, access.dimension).length === 0) {
					throw new ForbiddenError(`The caller does not hold '${action}' in this ${access.dimension}`)
				}
				const chain = await this.#chain(access.dimension, value)
				if (!holdsOnChain(caller.perms, action, access.dimension, value, chain ?? new Map())) {
					throw new ForbiddenError(`The caller does not hold '${action}' in this ${access.dimension}`)
				}
				if (chain === null) {
					throw new NotFoundError('Not found')
				}
				return { context: { target: mintRef(frame, access.dimension, action, caller.subject, value, chain) }, input: rest }
			}
			case 'on': {
				const { value, rest } = takeField(input, accessField(row, access))
				const chain = await this.#chain(access.dimension, value)
				// An object the caller may not act on is indistinguishable from a missing one.
				if (chain === null || !holdsOnChain(caller.perms, action, access.dimension, value, chain)) {
					throw new NotFoundError('Not found')
				}
				return { context: { target: mintRef(frame, access.dimension, action, caller.subject, value, chain) }, input: rest }
			}
			case 'creates':
				throw new ServerFault(`'${row.id}' creates a scope, which this version does not serve`)
		}
	}

	/** The object's containers, read now, so a Ref carries where it lies today; `null` for a missing object a table owns. */
	async #chain(dimension: string, value: string): Promise<ReadonlyMap<string, string> | null> {
		const database = this.#parts.database
		if (database === null || !this.#parts.ownedDimensions.has(dimension)) {
			return new Map()
		}
		return await database.locate(dimension, value)
	}

	/** The container values of `dimension` in which the caller holds `action`. */
	#heldContainers(perms: PermissionEntry[], action: string, dimension: string): ContainerGrant[] {
		return (this.#parts.containers.get(dimension) ?? []).flatMap((container) => {
			const values = scopedValues(perms, action, container) ?? []
			return values.length === 0 ? [] : [{ dimension: container, values }]
		})
	}
}

/** Whether the caller holds `action` on the value or on any container of its chain; IAM evaluates each as a flat scope. */
function holdsOnChain(perms: PermissionEntry[], action: string, dimension: string, value: string, chain: ReadonlyMap<string, string>): boolean {
	const scopes: (readonly [string, string])[] = [[dimension, value], ...chain]
	return scopes.some(([type, scope]) => permits(perms, action, { type, value: scope }))
}

function accessField(row: CredentialedEndpoint, access: Extract<AccessForm, { form: 'on' }>): string {
	if (access.from === null) {
		throw new ServerFault(`'${row.id}' is bound to a link's object, which this version does not serve`)
	}
	return access.from
}

function projectOutput(served: Extract<ServedEndpoint, { kind: 'procedure' }>, result: unknown): unknown {
	try {
		return project(served.output, result)
	} catch (error) {
		if (error instanceof ProjectionRefusedError) {
			throw new ServerFault(`'${served.row.id}' returned a value no branch of its output union accepts`)
		}
		throw error
	}
}

/**
 * Admission. A request that carries no `Authorization` header is authenticated by the session cookie the proxy
 * redeemed; when it is not a `GET`, it must come from this origin. A cross-site page cannot add the header: it is
 * not CORS-safelisted, and the application answers no preflight.
 */
function admit(row: CredentialedEndpoint, request: Request): void {
	if (request.method !== 'GET' && !request.headers.has('Authorization') && request.headers.get('Sec-Fetch-Site') !== 'same-origin') {
		throw new HttpError(403, 'admission', 'A session request that is not a GET must be same-origin (Sec-Fetch-Site: same-origin)')
	}
	if (row.admission !== null) {
		const type = mediaType(request.headers.get('Content-Type'))
		if (type === null || !row.admission.contentTypes.includes(type)) {
			throw new HttpError(400, 'admission', `'${row.id}' admits Content-Type ${row.admission.contentTypes.join(' or ')}`)
		}
	}
}

/** The strictly parsed input; a procedure without input takes an empty body or `{}`. */
async function readInput(served: Extract<ServedEndpoint, { kind: 'procedure' }>, request: Request): Promise<Readonly<Record<string, unknown>>> {
	const text = await request.text()
	let body: unknown = {}
	if (text.trim() !== '') {
		try {
			body = JSON.parse(text)
		} catch {
			throw new BadRequestError('The body is not JSON')
		}
	}
	if (served.input === null) {
		if (!isRecord(body) || Object.keys(body).length > 0) {
			throw new BadRequestError(`'${served.row.id}' takes no input; send {} or an empty body`)
		}
		return {}
	}
	const parsed = z.safeParse(served.input, body)
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code, message: issue.message }))
		const first = issues[0]
		throw new HttpError(400, 'validation', first === undefined ? 'Invalid input' : `${first.path || 'input'}: ${first.message}`, { issues })
	}
	if (!isRecord(parsed.data)) {
		throw new BadRequestError('The input is not an object')
	}
	return parsed.data
}

/** A canonical path's segments all decode; a value that does not is no id of anything. */
function decodePathParameter(raw: string): string {
	try {
		return decodeURIComponent(raw)
	} catch {
		throw new BadRequestError('A path parameter does not decode')
	}
}

/** Removes the `from` field: the only copy of that id the handler gets is the checked capability. */
function takeField(
	input: Readonly<Record<string, unknown>>,
	field: string,
): { readonly value: string; readonly rest: Readonly<Record<string, unknown>> } {
	const value = input[field]
	if (typeof value !== 'string') {
		throw new BadRequestError(`${field}: a string is required`)
	}
	const rest = Object.fromEntries(Object.entries(input).filter(([name]) => name !== field))
	return { value, rest: Object.freeze(rest) }
}

/** A failure the framework itself describes; its message is safe for the server log, never for the response. */
export class ServerFault extends Error {
	override readonly name = 'ServerFault'
	readonly status: number

	constructor(message: string, status = 500) {
		super(message)
		this.status = status
	}
}

/** The only body a 5xx carries: what failed stays on the server, because it may quote a credential. */
function serverError(status: number): Response {
	return status === 503
		? jsonResponse({ error: { type: 'unavailable', message: 'Service unavailable' } }, 503)
		: jsonResponse({ error: { type: 'internal', message: 'Internal error' } }, status)
}

/**
 * A short line for the server log, never the error object: a framework-authored message, or only the name of
 * anything else, whose message the application or a driver wrote.
 */
function logFailure(where: string, error: unknown): void {
	const detail = error instanceof ServerFault || error instanceof CapabilityRefusedError || error instanceof CapabilityLimitError
		? error.message
		: `${error instanceof Error ? error.name : typeof error} thrown`
	console.error(`fabrika: ${where}: ${detail}`)
}

/**
 * One envelope, `{ error: { type, message, issues? } }`. A client error keeps its own message and issues; every
 * 5xx and every refused capability answers a fixed message, and its detail goes to the server log only.
 */
export function errorResponse(error: unknown, where: string): Response {
	if (isStructuralError(error) && error.httpStatus < 500) {
		return toErrorResponse(error)
	}
	if (error instanceof CapabilityLimitError) {
		logFailure(where, error)
		return toErrorResponse(new ForbiddenError(`The caller holds the action in more scope values than one list may carry (${MAX_WITHIN_VALUES})`))
	}
	const name = error instanceof Error ? error.name : ''
	// `@fabrika/db` errors carry no status; they are read by name, never by a cross-package `instanceof`.
	if (name === 'NotFoundError') {
		return toErrorResponse(new NotFoundError('Not found'))
	}
	if (name === 'ConflictError') {
		return toErrorResponse(new HttpError(409, 'conflict', 'The object changed since it was read'))
	}
	logFailure(where, error)
	if (error instanceof ServerFault) {
		return serverError(error.status)
	}
	return serverError(isStructuralError(error) ? error.httpStatus : 500)
}
