// The per-request pipeline of a contract application (ADR-0012 §5): canonical path and endpoint selection, the
// token, the caller kind, the requirement, admission, strict input, the access form, the handler, output
// projection. The caller-kind, requirement and access checks are authorization; the same-origin and content-type
// checks are admission. Neither evaluates a gate: the proxy has already decided that the request may reach us.

import {
	type AccessForm,
	type CompiledEndpointTable,
	type CredentialedEndpoint,
	type EndpointRow,
	type PermissionEntry,
	permits,
	planEndpoint,
	PROXY_TOKEN_HEADER,
	rawRequestTarget,
	satisfies,
	type SchemaShape,
	scopedValues,
} from '@fabrika/auth-core'
import type { TokenVerifier } from '@fabrika/jwks'
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
import { mintRef, mintWithin, RequestFrame, runInRequest } from './capability'
import { type HeaderPolicy, withHeaderPolicy } from './headers'
import type { ContractDatabase } from './implement'
import { presentedBy, type Principal } from './principal'
import { project } from './project'

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

export interface RuntimeParts {
	readonly table: CompiledEndpointTable
	readonly endpoints: ReadonlyMap<string, ServedEndpoint>
	readonly verifier: TokenVerifier
	/** The token audience: this application's IAM id. */
	readonly appId: string
	readonly policy: HeaderPolicy
	readonly database: ContractDatabase | null
	/** Dimensions a table owns, so `in` and `on` must find the object. */
	readonly ownedDimensions: ReadonlySet<string>
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

	async fetch(request: Request): Promise<Response> {
		return withHeaderPolicy(await this.#answer(request), this.#parts.policy)
	}

	async #answer(request: Request): Promise<Response> {
		try {
			const plan = planEndpoint(this.#parts.table, request.method, rawRequestTarget(request.url).pathname)
			if (plan.outcome === 'non-canonical') {
				throw new BadRequestError('The request path is not canonical')
			}
			const served = plan.outcome === 'endpoint' ? this.#parts.endpoints.get(plan.endpoint.id) : undefined
			if (served === undefined) {
				throw new NotFoundError(`No endpoint serves ${request.method} ${rawRequestTarget(request.url).pathname}`)
			}
			switch (served.kind) {
				case 'health':
					return jsonResponse({ status: 'ok' }, 200)
				case 'spa': {
					await this.#authorize(served.row, request)
					const assets = this.#parts.assets
					if (assets === null) {
						throw new HttpError(500, 'internal', 'No asset server serves the SPA')
					}
					return await assets.serve({ prefix: served.prefix, dir: served.dir }, request)
				}
				case 'procedure':
					return await this.#procedure(served, request)
			}
		} catch (error) {
			return errorResponse(error)
		}
	}

	/** Token, caller kind, requirement, then admission. */
	async #authorize(row: CredentialedEndpoint, request: Request): Promise<Caller> {
		const token = request.headers.get(PROXY_TOKEN_HEADER)?.trim() ?? ''
		if (token === '') {
			throw new UnauthorizedError('This endpoint needs a credential, and the request carries none')
		}
		const verified = await this.#parts.verifier.verify(token, this.#parts.appId)
		if (!verified.ok) {
			if (verified.reason === 'unavailable') {
				throw new HttpError(503, 'unavailable', 'The IAM key set could not be fetched; nothing was checked')
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
		const output = z.safeParse(served.output, project(outputShape(served.row), result))
		if (!output.success) {
			throw new HttpError(500, 'internal', `'${served.row.id}' returned a value its output schema refuses`)
		}
		return jsonResponse({ result: output.data }, 200)
	}

	async #access(row: CredentialedEndpoint, caller: Caller, input: Readonly<Record<string, unknown>>, frame: RequestFrame): Promise<Access> {
		if (row.requirement.kind === 'member') {
			return { context: {}, input }
		}
		const { action, access } = row.requirement
		switch (access.form) {
			case 'over': {
				const values = scopedValues(caller.perms, action, access.dimension)
				if (values !== null && values.length === 0) {
					throw new ForbiddenError(`The caller holds '${action}' in no ${access.dimension}`)
				}
				return { context: { within: mintWithin(frame, access.dimension, action, caller.subject, values ?? 'all') }, input }
			}
			case 'in': {
				const { value, rest } = takeField(input, access.from)
				if (!permits(caller.perms, action, { type: access.dimension, value })) {
					throw new ForbiddenError(`The caller does not hold '${action}' in this ${access.dimension}`)
				}
				const chain = await this.#locate(access.dimension, value)
				return { context: { target: mintRef(frame, access.dimension, action, caller.subject, value, chain) }, input: rest }
			}
			case 'on': {
				const { value, rest } = takeField(input, accessField(row, access))
				const chain = await this.#locate(access.dimension, value)
				const scopes: (readonly [string, string])[] = [[access.dimension, value], ...chain]
				// An object the caller may not act on is indistinguishable from a missing one.
				if (!scopes.some(([type, scope]) => permits(caller.perms, action, { type, value: scope }))) {
					throw new NotFoundError('Not found')
				}
				return { context: { target: mintRef(frame, access.dimension, action, caller.subject, value, chain) }, input: rest }
			}
			case 'creates':
				throw new HttpError(500, 'internal', `'${row.id}' creates a scope, which this version does not serve`)
		}
	}

	/** The object's containers; a missing object of a dimension a table owns is 404. */
	async #locate(dimension: string, value: string): Promise<ReadonlyMap<string, string>> {
		const database = this.#parts.database
		if (database === null || !this.#parts.ownedDimensions.has(dimension)) {
			return new Map()
		}
		const chain = await database.locate(dimension, value)
		if (chain === null) {
			throw new NotFoundError('Not found')
		}
		return chain
	}
}

function accessField(row: CredentialedEndpoint, access: Extract<AccessForm, { form: 'on' }>): string {
	if (access.from === null) {
		throw new HttpError(500, 'internal', `'${row.id}' is bound to a link's object, which this version does not serve`)
	}
	return access.from
}

function outputShape(row: CredentialedEndpoint): SchemaShape {
	if (row.output === null) {
		throw new HttpError(500, 'internal', `'${row.id}' declares no output`)
	}
	return row.output
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

/** One envelope, `{ error: { type, message, issues? } }`. An unexpected error says nothing about itself. */
export function errorResponse(error: unknown): Response {
	if (isStructuralError(error)) {
		return toErrorResponse(error)
	}
	const name = error instanceof Error ? error.name : ''
	switch (name) {
		// `@fabrika/db` errors carry no status; they are read by name, never by a cross-package `instanceof`.
		case 'NotFoundError':
			return toErrorResponse(new NotFoundError('Not found'))
		case 'ConflictError':
			return toErrorResponse(new HttpError(409, 'conflict', 'The object changed since it was read'))
		case 'CapabilityError':
		case 'CapabilityRefusedError':
			return toErrorResponse(new HttpError(500, 'capability', error instanceof Error ? error.message : 'A capability was refused'))
		default:
			return toErrorResponse(new HttpError(500, 'internal', 'Internal error'))
	}
}
