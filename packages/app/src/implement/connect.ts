// `ctx.connect`: the consumer side of a connector. A call validates its input against the vendored snapshot, posts it
// to the owner's export procedure with the edge key as the bearer, and answers a typed outcome. A deadline bounds the
// call and its retries; the answer is validated against the vendored output schema, so drift shows on the first call.

import {
	API_KEY_PREFIX,
	type ConnectVariables,
	connectVariables,
	type ContractArtifact,
	type ExportDescription,
	type ImportArtifact,
	type SchemaShape,
} from '@fabrika/auth-core'
import { z } from 'zod/v4'
import { type ConnectSnapshot, describeSnapshot } from '../contract/connect'
import { CONNECT_LIMITS, CONNECT_PREFIX, exportBase, joinPath } from '../contract/defaults'
import { ContractError } from '../contract/problems'
import { declaredPath, schemaFromShape } from '../contract/schema-from-shape'
import { readBoundedBytes } from './bounded'
import { activeRequest, type RequestFrame } from './capability'

export type ConnectFailure = 'denied' | 'invalid_input' | 'unavailable' | 'timeout' | 'contract_violation'

/** `unavailable` and `timeout` are never reported as `denied`: "we could not ask" is not "no". */
export type ConnectResult<T> =
	| { readonly outcome: 'ok'; readonly value: T }
	| { readonly outcome: ConnectFailure; readonly message: string }

/** How a request reaches the owner's proxy: `fetch` over HTTPS, or a service binding to its proxy Worker. */
export type ConnectFetch = (request: Request) => Promise<Response>

/** Every import's variables and binding are named under it (`connectVariables`, `@fabrika/auth-core`). */
export const CONNECT_BINDING_PREFIX = 'FABRIKA_CONNECT_'

export { type ConnectVariables, connectVariables }

/**
 * One procedure as the connector validates it: zod schemas built by the framework from the snapshot's described
 * shapes, never the application's schema objects, so nothing the application changes after `boot` reaches them.
 */
interface CompiledProcedure {
	readonly input: z.ZodType | null
	readonly inputShape: SchemaShape | null
	readonly output: z.ZodType
	readonly outputShape: SchemaShape
}

export interface ConnectorOptions {
	/** The import's name in the contract, for the log line of a contract violation. */
	readonly name: string
	readonly export: string
	readonly version: number
	readonly origin: string
	readonly key: string
	readonly fetch: ConnectFetch
	readonly timeoutMs: number
	/** The imported procedures of the checked description, by path. */
	readonly description: ExportDescription
	readonly procedures: readonly string[]
}

type Attempt = ConnectResult<unknown> & { readonly retry: boolean }

function failure(outcome: ConnectFailure, message: string, retry = false): Attempt {
	return { outcome, message, retry }
}

/** `application/json`, with or without parameters, is the only media type an export answers in. */
export function isJsonMediaType(header: string | null): boolean {
	return header?.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

async function discard(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => {})
}

/** One import's calls. A message names only what the framework wrote; the edge key is cut out of it regardless. */
export class Connector {
	readonly #options: ConnectorOptions
	readonly #procedures: ReadonlyMap<string, CompiledProcedure>

	constructor(options: ConnectorOptions) {
		this.#options = options
		const procedures = new Map<string, CompiledProcedure>()
		for (const path of options.procedures) {
			const described = Object.hasOwn(options.description.procedures, path) ? options.description.procedures[path] : undefined
			if (described !== undefined) {
				procedures.set(path, {
					input: described.input === null ? null : schemaFromShape(described.input),
					inputShape: described.input,
					output: schemaFromShape(described.output),
					outputShape: described.output,
				})
			}
		}
		this.#procedures = procedures
	}

	async call(path: string, input: unknown): Promise<ConnectResult<unknown>> {
		const procedure = this.#procedures.get(path)
		if (procedure === undefined) {
			return { outcome: 'invalid_input', message: 'not an imported procedure' }
		}
		const parsed = procedure.input === null ? null : z.safeParse(procedure.input, input ?? {})
		if (parsed !== null && !parsed.success) {
			const issue = parsed.error.issues[0]
			const at = procedure.inputShape === null || issue === undefined ? '(root)' : declaredPath(procedure.inputShape, issue.path)
			return { outcome: 'invalid_input', message: this.#redact(`the input breaks the vendored input schema at ${at} (${issue?.code ?? 'invalid'})`) }
		}
		const body = JSON.stringify(parsed === null ? {} : parsed.data)
		const deadline = Date.now() + this.#options.timeoutMs
		let last: Attempt = failure('timeout', `no answer within ${this.#options.timeoutMs} ms`)
		for (let attempt = 0; attempt <= CONNECT_LIMITS.retries; attempt++) {
			const remaining = deadline - Date.now()
			if (remaining <= 0) {
				break
			}
			// The remaining time is shared by the attempts still allowed, so a hung first try leaves room for a retry.
			last = await this.#attempt(path, body, procedure, Math.max(1, Math.floor(remaining / (CONNECT_LIMITS.retries + 1 - attempt))))
			if (!last.retry) {
				break
			}
		}
		const message = this.#redact(last.outcome === 'ok' ? '' : last.message)
		if (last.outcome === 'contract_violation') {
			console.error(`fabrika: connect '${this.#options.name}.${path}': contract_violation: ${message}`)
		}
		return last.outcome === 'ok' ? { outcome: 'ok', value: last.value } : { outcome: last.outcome, message }
	}

	/** Defence in depth: no framework message quotes the answer, and the edge key is cut out of every one anyway. */
	#redact(message: string): string {
		return message.replaceAll(this.#options.key, '[edge key]')
	}

	/** One request under its own deadline; the deadline aborts the fetch and cancels the body reader. */
	async #attempt(path: string, body: string, procedure: CompiledProcedure, timeoutMs: number): Promise<Attempt> {
		const { origin, key } = this.#options
		const url = new URL(joinPath(CONNECT_PREFIX, `${exportBase(this.#options.export, this.#options.version)}.${path}`), origin)
		const controller = new AbortController()
		const timedOut = failure('timeout', `no answer within ${timeoutMs} ms`, true)
		const expired = new Promise<Attempt>((resolve) => controller.signal.addEventListener('abort', () => resolve(timedOut), { once: true }))
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const request = new Request(url, {
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body,
				signal: controller.signal,
				redirect: 'manual',
			})
			const exchanged = this.#exchange(request, procedure, controller.signal).catch(() =>
				controller.signal.aborted ? timedOut : failure('unavailable', 'the owner could not be reached', true)
			)
			return await Promise.race([exchanged, expired])
		} finally {
			clearTimeout(timer)
			// Whatever is still reading or waiting after the answer — or the deadline — stops here.
			controller.abort()
		}
	}

	async #exchange(request: Request, procedure: CompiledProcedure, signal: AbortSignal): Promise<Attempt> {
		const response = await this.#options.fetch(request)
		const status = response.status
		if (signal.aborted || status !== 200) {
			await discard(response)
		}
		if (signal.aborted) {
			return failure('timeout', 'no answer before the deadline', true)
		}
		if (status === 200) {
			return await this.#answer(response, procedure, signal)
		}
		if (status >= 300 && status < 400) {
			return failure('unavailable', `the owner answered ${status}, a redirect, which a connector never follows`)
		}
		if (status === 400) {
			return failure('invalid_input', 'the owner refused the input')
		}
		if (status === 401 || status === 403 || status === 404) {
			return failure('denied', `the owner answered ${status}`)
		}
		if (status === 408 || status === 429 || status >= 500) {
			return failure('unavailable', `the owner answered ${status}`, true)
		}
		return failure('contract_violation', `the owner answered ${status}, which no export procedure answers`)
	}

	async #answer(response: Response, procedure: CompiledProcedure, signal: AbortSignal): Promise<Attempt> {
		if (!isJsonMediaType(response.headers.get('Content-Type'))) {
			await discard(response)
			return failure('contract_violation', 'the answer is not application/json')
		}
		const bytes = await readBoundedBytes(response.body, {
			maxBytes: CONNECT_LIMITS.maxAnswerBytes,
			declaredLength: response.headers.get('Content-Length'),
			signal,
		})
		if (bytes === null) {
			return failure('contract_violation', `the answer is larger than ${CONNECT_LIMITS.maxAnswerBytes} bytes`)
		}
		let answer: unknown
		try {
			answer = JSON.parse(new TextDecoder().decode(bytes))
		} catch {
			return failure('contract_violation', 'the answer is not JSON')
		}
		const result = typeof answer === 'object' && answer !== null && 'result' in answer ? answer.result : undefined
		const parsed = z.safeParse(procedure.output, result)
		if (!parsed.success) {
			const issue = parsed.error.issues[0]
			const at = issue === undefined ? '(root)' : declaredPath(procedure.outputShape, issue.path)
			return failure('contract_violation', `the answer breaks the vendored output schema at ${at} (${issue?.code ?? 'invalid'})`)
		}
		return { outcome: 'ok', value: parsed.data, retry: false }
	}
}

/** `ctx.connect` of one request: each import its endpoint's `usedBy` names, with the procedures the contract imports. */
export type ConnectContextValue = Readonly<Record<string, Readonly<Record<string, (input?: unknown) => Promise<ConnectResult<unknown>>>>>>

/** One import as an endpoint may use it. */
export interface ImportWire {
	readonly name: string
	readonly connector: Connector
	readonly procedures: readonly string[]
	readonly usedBy: ReadonlySet<string>
}

const REFUSED: ConnectResult<never> = Object.freeze({
	outcome: 'denied',
	message: 'ctx.connect works only inside the request that received it, in a handler the import names in usedBy',
})

/**
 * The `ctx.connect` of one request, bound to its frame. A method kept past its request, called from another request,
 * from an export's (read-only) request or from an endpoint the import does not name is `denied`, and sends nothing.
 */
export function connectContext(imports: readonly ImportWire[], frame: RequestFrame): ConnectContextValue {
	const call = (wire: ImportWire, path: string, input: unknown): Promise<ConnectResult<unknown>> => {
		const endpoint = frame.endpoint
		if (activeRequest() !== frame || frame.ended || frame.readOnly || endpoint === null || !wire.usedBy.has(endpoint)) {
			return Promise.resolve(REFUSED)
		}
		return wire.connector.call(path, input)
	}
	return Object.freeze(Object.fromEntries(imports.map((wire) => [
		wire.name,
		Object.freeze(Object.fromEntries(wire.procedures.map((path) => [path, (input?: unknown) => call(wire, path, input)]))),
	])))
}

export interface ImportWiring {
	readonly artifact: ContractArtifact
	readonly snapshots: Readonly<Record<string, ConnectSnapshot>>
	/** The captured `FABRIKA_*` variables, which carry each import's URL and edge key. */
	readonly framework: Readonly<Record<string, string>>
	/** Cloudflare service bindings to owners' proxy Workers, by binding name; any other import uses `fallback`. */
	readonly bindings: Readonly<Record<string, ConnectFetch>>
	readonly fallback: ConnectFetch
}

/**
 * The imports each endpoint may use. Each import must come with the snapshot its digest names, unedited, and with its
 * owner's URL and edge key; otherwise `problems` says why. What a connector validates against is compiled here, once,
 * from the checked description, before the application's `deps` run.
 */
export function wireImports(wiring: ImportWiring, problems: string[]): ReadonlyMap<string, readonly ImportWire[]> {
	const { artifact, snapshots, framework } = wiring
	const byEndpoint = new Map<string, ImportWire[]>()
	const bindings = new Map<string, string>()
	for (const name of Object.keys(snapshots)) {
		if (!Object.hasOwn(artifact.imports, name)) {
			problems.push(`implement({ connect }) passes a snapshot as '${name}', and the contract imports nothing of that name`)
		}
	}
	for (const [name, declared] of Object.entries(artifact.imports)) {
		const where = `import '${name}'`
		const snapshot = Object.hasOwn(snapshots, name) ? snapshots[name] : undefined
		if (snapshot === undefined) {
			problems.push(`${where} has no snapshot; pass implement({ connect: { ${name}: <the snapshot in fabrika/connect/> } })`)
			continue
		}
		const description = checkedDescription(where, declared, snapshot, problems)
		if (description === null) {
			continue
		}
		const variables = connectVariables(name)
		const other = bindings.get(variables.binding)
		if (other !== undefined) {
			problems.push(`${where} and import '${other}' both read ${variables.binding}_*; rename one of them`)
			continue
		}
		bindings.set(variables.binding, name)
		const origin = readOrigin(variables.url, framework[variables.url], problems)
		const key = framework[variables.key] ?? ''
		if (!key.startsWith(API_KEY_PREFIX)) {
			problems.push(`${variables.key} is not set to a ${API_KEY_PREFIX} key; the platform writes the key the owner's proxy admits ${where} with`)
		}
		if (origin === null || !key.startsWith(API_KEY_PREFIX)) {
			continue
		}
		const procedures = Object.freeze([...declared.procedures])
		const wire: ImportWire = Object.freeze({
			name,
			procedures,
			usedBy: new Set(declared.usedBy),
			connector: new Connector({
				name,
				export: declared.export,
				version: declared.version,
				origin,
				key,
				fetch: Object.hasOwn(wiring.bindings, variables.binding) ? (wiring.bindings[variables.binding] ?? wiring.fallback) : wiring.fallback,
				timeoutMs: declared.timeoutMs ?? CONNECT_LIMITS.defaultTimeoutMs,
				description,
				procedures,
			}),
		})
		for (const id of declared.usedBy) {
			byEndpoint.set(id, [...(byEndpoint.get(id) ?? []), wire])
		}
	}
	return byEndpoint
}

function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const child of Object.values(value)) {
			deepFreeze(child)
		}
	}
	return value
}

/** The snapshot's description, deep-frozen and independent of the snapshot object, when it is the import's. */
function checkedDescription(where: string, declared: ImportArtifact, snapshot: ConnectSnapshot, problems: string[]): ExportDescription | null {
	const named = `${snapshot.app}/${snapshot.export}@${snapshot.version}`
	if (snapshot.app !== declared.app || snapshot.export !== declared.export || snapshot.version !== declared.version) {
		problems.push(`${where} imports ${declared.app}/${declared.export}@${declared.version}, and its snapshot is ${named}`)
		return null
	}
	if (snapshot.digest !== declared.digest) {
		problems.push(`${where} names digest ${declared.digest}, and its snapshot is ${snapshot.digest}; import the digest from the snapshot`)
		return null
	}
	let description: ExportDescription
	try {
		description = describeSnapshot(snapshot)
	} catch (error) {
		problems.push(...(error instanceof ContractError ? error.problems : [`the snapshot ${named} does not describe`]))
		return null
	}
	if (description.digest !== declared.digest) {
		problems.push(`the snapshot ${named} was edited after fabrika connect wrote it; run fabrika connect pull`)
		return null
	}
	const missing = declared.procedures.filter((path) => !Object.hasOwn(description.procedures, path))
	if (missing.length > 0) {
		problems.push(`${where} imports ${missing.join(', ')}, which ${named} does not export`)
		return null
	}
	return deepFreeze(description)
}

/** The owner's origin; the value is never quoted, since an operator may paste a URL with credentials in it. */
function readOrigin(name: string, raw: string | undefined, problems: string[]): string | null {
	if (raw === undefined || raw.trim() === '') {
		problems.push(`${name} is not set; the platform writes the origin of the owner's proxy`)
		return null
	}
	try {
		const url = new URL(raw.trim())
		if ((url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '') {
			return url.origin
		}
	} catch {
		// Reported below.
	}
	problems.push(`${name} is not an http(s) origin without credentials`)
	return null
}
