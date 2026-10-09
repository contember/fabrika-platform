// `ctx.connect`: the consumer side of a connector. A call validates its input against the vendored snapshot, posts it
// to the owner's export procedure with the edge key as the bearer, and answers a typed outcome. A deadline bounds the
// call and its retries; the answer is validated against the vendored output schema, so drift shows on the first call.

import { API_KEY_PREFIX, type ContractArtifact, type ImportArtifact } from '@fabrika/auth-core'
import { z } from 'zod/v4'
import { type ConnectSnapshot, describeSnapshot } from '../contract/connect'
import { CONNECT_LIMITS, CONNECT_PREFIX, exportBase, joinPath } from '../contract/defaults'
import type { InputSchema, Schema } from '../contract/define'
import { ContractError } from '../contract/problems'

export type ConnectFailure = 'denied' | 'invalid_input' | 'unavailable' | 'timeout' | 'contract_violation'

/** `unavailable` and `timeout` are never reported as `denied`: "we could not ask" is not "no". */
export type ConnectResult<T> =
	| { readonly outcome: 'ok'; readonly value: T }
	| { readonly outcome: ConnectFailure; readonly message: string }

/** How a request reaches the owner's proxy: `fetch` over HTTPS, or a service binding to its proxy Worker. */
export type ConnectFetch = (request: Request) => Promise<Response>

/** The framework variables that configure one import, and the Worker binding that carries it on Cloudflare. */
export interface ConnectVariables {
	/** The owner's origin, `https://<owner host>`; on Cloudflare also the URL a binding request carries. */
	readonly url: string
	/** The edge's `px_` key. Until B9 an operator provisions it; application code never reads it. */
	readonly key: string
	readonly binding: string
}

/** Every import's variables and binding are named under it. */
export const CONNECT_BINDING_PREFIX = 'FABRIKA_CONNECT_'

/** `catalog` → `FABRIKA_CONNECT_CATALOG_*`, `productCatalog` → `FABRIKA_CONNECT_PRODUCT_CATALOG_*`. */
export function connectVariables(importName: string): ConnectVariables {
	const binding = `${CONNECT_BINDING_PREFIX}${importName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
	return { url: `${binding}_URL`, key: `${binding}_KEY`, binding }
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
	readonly procedures: Readonly<Record<string, { readonly input: InputSchema | null; readonly output: Schema }>>
}

class AttemptTimeout extends Error {
	override readonly name = 'AttemptTimeout'
}

type Attempt = ConnectResult<unknown> & { readonly retry: boolean }

function failure(outcome: ConnectFailure, message: string, retry = false): Attempt {
	return { outcome, message, retry }
}

/** One import's calls. Each method of `ctx.connect.<import>` is `call` bound to one imported procedure. */
export class Connector {
	readonly #options: ConnectorOptions

	constructor(options: ConnectorOptions) {
		this.#options = options
	}

	async call(path: string, input: unknown): Promise<ConnectResult<unknown>> {
		const procedure = Object.hasOwn(this.#options.procedures, path) ? this.#options.procedures[path] : undefined
		if (procedure === undefined) {
			return { outcome: 'invalid_input', message: `'${path}' is not an imported procedure` }
		}
		const parsed = procedure.input === null ? null : z.safeParse(procedure.input, input ?? {})
		if (parsed !== null && !parsed.success) {
			const issue = parsed.error.issues[0]
			return {
				outcome: 'invalid_input',
				message: issue === undefined ? 'Invalid input' : `${issue.path.map(String).join('.') || 'input'}: ${issue.message}`,
			}
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
			last = await this.#attempt(path, body, procedure.output, Math.max(1, Math.floor(remaining / (CONNECT_LIMITS.retries + 1 - attempt))))
			if (!last.retry) {
				break
			}
		}
		if (last.outcome === 'contract_violation') {
			console.error(`fabrika: connect '${this.#options.name}.${path}': contract_violation: ${last.message}`)
		}
		return last.outcome === 'ok' ? { outcome: 'ok', value: last.value } : { outcome: last.outcome, message: last.message }
	}

	async #attempt(path: string, body: string, output: Schema, timeoutMs: number): Promise<Attempt> {
		const { origin, key } = this.#options
		const url = new URL(joinPath(CONNECT_PREFIX, `${exportBase(this.#options.export, this.#options.version)}.${path}`), origin)
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | undefined
		const expired = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort()
				reject(new AttemptTimeout())
			}, timeoutMs)
		})
		try {
			const request = new Request(url, {
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body,
				signal: controller.signal,
			})
			return await Promise.race([this.#exchange(request, output), expired])
		} catch (error) {
			return error instanceof AttemptTimeout
				? failure('timeout', `no answer within ${timeoutMs} ms`, true)
				: failure('unavailable', 'the owner could not be reached', true)
		} finally {
			clearTimeout(timer)
		}
	}

	async #exchange(request: Request, output: Schema): Promise<Attempt> {
		const response = await this.#options.fetch(request)
		const status = response.status
		if (status === 200) {
			let answer: unknown
			try {
				answer = await response.json()
			} catch {
				return failure('contract_violation', 'the answer is not JSON')
			}
			const result = typeof answer === 'object' && answer !== null && 'result' in answer ? answer.result : undefined
			const parsed = z.safeParse(output, result)
			if (!parsed.success) {
				const issue = parsed.error.issues[0]
				return failure('contract_violation', `the answer breaks the vendored output schema at '${issue?.path.map(String).join('.') ?? ''}'`)
			}
			return { outcome: 'ok', value: parsed.data, retry: false }
		}
		await response.body?.cancel()
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
}

/** `ctx.connect` of one endpoint: each import its `usedBy` names, with the procedures the contract imports. */
export type ConnectContextValue = Readonly<Record<string, Readonly<Record<string, (input?: unknown) => Promise<ConnectResult<unknown>>>>>>

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
 * The connectors of every import, as the `ctx.connect` of each endpoint that may use them. Each import must come
 * with the snapshot its digest names, unedited, and with its owner's URL and edge key; otherwise `problems` says why.
 */
export function wireImports(wiring: ImportWiring, problems: string[]): ReadonlyMap<string, ConnectContextValue> {
	const { artifact, snapshots, framework } = wiring
	const contexts = new Map<string, Record<string, ConnectContextValue[string]>>()
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
		if (!matchesSnapshot(where, declared, snapshot, problems)) {
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
			problems.push(`${variables.key} is not set to a ${API_KEY_PREFIX} key; it is the edge key the owner's proxy admits ${where} with`)
		}
		if (origin === null || !key.startsWith(API_KEY_PREFIX)) {
			continue
		}
		const procedures = Object.fromEntries(declared.procedures.flatMap((path) => {
			const procedure = snapshot.procedures[path]
			return procedure === undefined ? [] : [[path, procedure]]
		}))
		const connector = new Connector({
			name,
			export: declared.export,
			version: declared.version,
			origin,
			key,
			fetch: Object.hasOwn(wiring.bindings, variables.binding) ? (wiring.bindings[variables.binding] ?? wiring.fallback) : wiring.fallback,
			timeoutMs: declared.timeoutMs ?? CONNECT_LIMITS.defaultTimeoutMs,
			procedures,
		})
		const calls = Object.freeze(Object.fromEntries(declared.procedures.map((path) => [path, (input?: unknown) => connector.call(path, input)])))
		for (const id of declared.usedBy) {
			const context = contexts.get(id) ?? {}
			context[name] = calls
			contexts.set(id, context)
		}
	}
	return new Map([...contexts].map(([id, context]) => [id, Object.freeze(context)]))
}

function matchesSnapshot(where: string, declared: ImportArtifact, snapshot: ConnectSnapshot, problems: string[]): boolean {
	const named = `${snapshot.app}/${snapshot.export}@${snapshot.version}`
	if (snapshot.app !== declared.app || snapshot.export !== declared.export || snapshot.version !== declared.version) {
		problems.push(`${where} imports ${declared.app}/${declared.export}@${declared.version}, and its snapshot is ${named}`)
		return false
	}
	if (snapshot.digest !== declared.digest) {
		problems.push(`${where} names digest ${declared.digest}, and its snapshot is ${snapshot.digest}; import the digest from the snapshot`)
		return false
	}
	let described: string
	try {
		described = describeSnapshot(snapshot).digest
	} catch (error) {
		problems.push(...(error instanceof ContractError ? error.problems : [`the snapshot ${named} does not describe`]))
		return false
	}
	if (described !== snapshot.digest) {
		problems.push(`the snapshot ${named} was edited after fabrika connect wrote it; run fabrika connect pull`)
		return false
	}
	const missing = declared.procedures.filter((path) => !Object.hasOwn(snapshot.procedures, path))
	if (missing.length > 0) {
		problems.push(`${where} imports ${missing.join(', ')}, which ${named} does not export`)
		return false
	}
	return true
}

/** The owner's origin; the value is never quoted, since an operator may paste a URL with credentials in it. */
function readOrigin(name: string, raw: string | undefined, problems: string[]): string | null {
	if (raw === undefined || raw.trim() === '') {
		problems.push(`${name} is not set; it is the origin of the owner's proxy`)
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
