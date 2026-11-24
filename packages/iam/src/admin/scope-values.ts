// A dimension's values, asked of the application as the signed-in administrator (ADR-0085 §4). IAM issues a
// short-lived key of that person carrying only the source procedure's action, and calls the procedure through the
// application's proxy, which exchanges the key like any other: the proxy stays the only enforcement point.

import {
	API_KEY_PREFIX,
	type DimensionValueSource,
	isReservedScopeType,
	LOCAL_ENVIRONMENT,
	MAX_DIMENSION_VALUES,
	MAX_SCOPE_VALUE_SOURCE_BYTES,
	parseDimensionValues,
	type PermissionEntry,
	SCOPE_VALUE_SOURCE_TIMEOUT_MS,
} from '@fabrika/auth-core'
import type { ListScopeValuesInput, ScopeValuesResult, ScopeValuesUnavailable } from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { unixNow } from '../repositories/sql'
import { resolvePermissionsAt } from '../resolve'
import { generateToken, hashToken } from '../secret'
import { parseStoredValueSource } from '../stored-permissions'
import { type AdminContext, adminEvent, fail } from './context'
import { requireManagedApp } from './user-admin'

/** How long the key IAM issues for one call lives: the call's deadline, and the token the proxy mints from it with it. */
export const SCOPE_VALUE_KEY_TTL_SECONDS = 60

/** The fetch IAM calls the application's proxy with; a test passes its own. */
export type SourceFetch = (input: Request) => Promise<Response>

/**
 * The values `input.scopeType` of `input.app` lists for the caller. Only a person signed in to the console who may
 * grant at the application asks (`requireManagedApp`); the key is that person's own, bound to the application, carries
 * only the source's action in the scopes the person holds it, and expires with the call. Its issue is audited in the
 * key's own transaction. A refusal by the application or its absence answers `unavailable`, never an error.
 */
export async function listScopeValuesUseCase(
	c: AdminContext,
	input: ListScopeValuesInput,
	sourceFetch: SourceFetch = (request) => fetch(request),
): Promise<ScopeValuesResult> {
	requireManagedApp(c, input.app)
	if (c.admin.type !== 'user' || !c.admin.session) {
		return fail(403, 'only a person signed in to the console asks an application for its values; a key does not')
	}
	const { appSchema, handoff, principals } = c.services.repositories
	const scope = await appSchema.getScope(input.app, input.scopeType)
	if (scope === null) return fail(404, `'${input.scopeType}' is not a scope of '${input.app}'`)
	const source = parseStoredValueSource(scope.value_source)
	if (source === null) return unavailable('no_source')
	const target = sourceUrl(await handoff.listReturnOrigins(input.app), source, c.services.config.environment === LOCAL_ENVIRONMENT)
	if (target === null) return unavailable('no_origin')
	const principal = await principals.getPrincipalById(c.admin.id)
	if (principal === null) return fail(404, 'principal not found')
	const grants = keyGrants(await resolvePermissionsAt(c.services, principal, input.app), source.action)
	if (grants === null) return unavailable('not_held')

	const key = `${API_KEY_PREFIX}${generateToken()}`
	const credentialId = uuidv7()
	const expiresAt = unixNow() + SCOPE_VALUE_KEY_TTL_SECONDS
	const { credentials, audit } = c.services.repositories
	await audit.commit([
		...credentials.credentialStatements(credentialId, {
			tokenHash: await hashToken(key),
			label: `scope values: ${input.scopeType}`,
			principalId: principal.id,
			app: input.app,
			issuedBy: principal.id,
			expiresAt,
			grants,
		}),
		audit.eventStatement(adminEvent(c, {
			action: 'iam.scope_values.read',
			resourceType: 'credential',
			resourceId: credentialId,
			metadata: { app: input.app, scopeType: input.scopeType, endpoint: source.endpoint, action: source.action, expiresAt },
		})),
	])
	return await askSource(sourceFetch, target, key)
}

function unavailable(reason: ScopeValuesUnavailable): ScopeValuesResult {
	return { source: 'unavailable', reason }
}

/**
 * The procedure's URL on the application's one registered origin, or null. The key goes only where its application is
 * served: an environment registering several origins (a dev environment's workspace sandboxes, each serving its own
 * contract) names none, a plain `http:` origin only in a local IAM, and never a path that would leave the origin.
 */
function sourceUrl(origins: readonly string[], source: DimensionValueSource, local: boolean): URL | null {
	const [origin] = origins
	if (origin === undefined || origins.length !== 1) return null
	try {
		const url = new URL(source.path, origin)
		if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null
		return url.origin === origin && url.pathname === source.path && url.search === '' ? url : null
	} catch {
		return null
	}
}

/**
 * The key's grants: the caller's entries of `action`, as they hold them (one global entry, else each scope), or null
 * when they hold it nowhere or in more scopes than a list holds values. A self-bound key's grants only narrow the person's
 * live permissions at every mint, so the key never carries more than the person holds then.
 */
function keyGrants(
	held: readonly PermissionEntry[],
	action: string,
): { action: string; scopeType: string | null; scopeValue: string | null }[] | null {
	const entries = held.filter((entry) => entry.action === action && (entry.scope === null || !isReservedScopeType(entry.scope.type)))
	if (entries.some((entry) => entry.scope === null)) return [{ action, scopeType: null, scopeValue: null }]
	if (entries.length === 0 || entries.length > MAX_DIMENSION_VALUES) return null
	const seen = new Set<string>()
	const grants: { action: string; scopeType: string | null; scopeValue: string | null }[] = []
	for (const { scope } of entries) {
		if (scope === null) continue
		const key = JSON.stringify([scope.type, scope.value])
		if (seen.has(key)) continue
		seen.add(key)
		grants.push({ action, scopeType: scope.type, scopeValue: scope.value })
	}
	return grants
}

/**
 * One call of the source through the application's proxy, with the key as the bearer: no redirect (it carries a
 * credential), one deadline for the answer and its body, and a bounded read. Every failure is an `unavailable` reason.
 */
async function askSource(sourceFetch: SourceFetch, target: URL, key: string): Promise<ScopeValuesResult> {
	const signal = AbortSignal.timeout(SCOPE_VALUE_SOURCE_TIMEOUT_MS)
	let response: Response
	try {
		response = await sourceFetch(
			new Request(target, {
				method: 'POST',
				redirect: 'manual',
				signal,
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
				body: '{}',
			}),
		)
	} catch {
		return unavailable(signal.aborted ? 'timeout' : 'unreachable')
	}
	if (response.status !== 200) {
		await response.body?.cancel().catch(() => {})
		return unavailable(response.status === 401 || response.status === 403 || response.status === 404 ? 'refused' : 'unreachable')
	}
	const body = await boundedJson(response)
	if (body === TIMED_OUT || signal.aborted) return unavailable('timeout')
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return unavailable('malformed')
	const values = parseDimensionValues(Reflect.get(body, 'result'))
	return values === null ? unavailable('malformed') : { source: 'application', values }
}

const TIMED_OUT = Symbol('timed out')

/** The answer's JSON, null when it is larger than `MAX_SCOPE_VALUE_SOURCE_BYTES` or no JSON, `TIMED_OUT` past the deadline. */
async function boundedJson(response: Response): Promise<unknown> {
	if (response.body === null || Number(response.headers.get('content-length') ?? '0') > MAX_SCOPE_VALUE_SOURCE_BYTES) {
		await response.body?.cancel().catch(() => {})
		return null
	}
	const reader = response.body.getReader()
	const decoder = new TextDecoder('utf-8', { fatal: true })
	let bytes = 0
	let text = ''
	try {
		while (true) {
			const chunk = await reader.read()
			if (chunk.done) break
			bytes += chunk.value.byteLength
			if (bytes > MAX_SCOPE_VALUE_SOURCE_BYTES) {
				await reader.cancel().catch(() => {})
				return null
			}
			text += decoder.decode(chunk.value, { stream: true })
		}
		text += decoder.decode()
	} catch (error) {
		return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError') ? TIMED_OUT : null
	}
	try {
		const parsed: unknown = JSON.parse(text)
		return parsed
	} catch {
		return null
	}
}
