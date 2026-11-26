// IAM's SCIM 2.0 service provider (RFC 7644) under `/scim/v2`, for the organization's identity provider (ADR-0091).
// Users only: create, get, list (`filter=userName eq "…"` or `externalId eq "…"`, paged), replace, PATCH, delete, and
// the discovery documents. No Groups, no Bulk, no sorting, no ETags.
//
// The bearer is the installation's one SCIM token (`scim_tokens`, hash only), compared by its SHA-256 digest; no token
// configured refuses every request. The token is never logged, and a refusal says nothing about why.

import { readBoundedText } from '../bounded-body'
import { normalizeEmailIdentity } from '../email-identity'
import { logError } from '../log'
import { hashToken, ISSUED_KEY_FORMAT } from '../secret'
import type { Services } from '../services'
import { DISCOVERY } from './discovery'
import {
	applyPatch,
	ERROR_SCHEMA,
	hasControlCharacter,
	LIST_RESPONSE_SCHEMA,
	parseUserBody,
	ScimError,
	type ScimUserState,
	stateOf,
	userNameKey,
	userResource,
} from './resource'
import { createUser, deleteUser, saveUser, type ScimActor, visible } from './users'

/** Where the surface is mounted; the tenant URL an identity provider is configured with. */
export const SCIM_BASE_PATH = '/scim/v2'

export const SCIM_CONTENT_TYPE = 'application/scim+json'

/** The largest request body read: a User is a few KiB, a PatchOp holds at most 100 operations. */
const MAX_BODY_BYTES = 64 * 1024

/** The page size when the provider names none, and the most one page holds (`filter.maxResults`). */
export const MAX_PAGE_SIZE = 100

const USERS = 'users'

/** Serve one SCIM request. */
export async function handleScim(request: Request, services: Services, requestId: string): Promise<Response> {
	try {
		const tokenId = await authenticate(request, services)
		if (tokenId === null) {
			return errorResponse(new ScimError(401, null, 'unauthorized'), { 'www-authenticate': 'Bearer' })
		}
		return await route(request, services, { tokenId, requestId })
	} catch (err) {
		if (err instanceof ScimError) return errorResponse(err)
		// The body may carry personal data and the request a token: only the message of an own error is logged.
		logError('scim request failed', err)
		return errorResponse(new ScimError(500, null, 'internal error'))
	}
}

async function authenticate(request: Request, services: Services): Promise<string | null> {
	const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization')?.trim() ?? '')
	const token = match?.[1] ?? null
	if (token === null || !ISSUED_KEY_FORMAT.test(token)) return null
	try {
		return await services.repositories.scim.tokenIdOf(await hashToken(token))
	} catch (err) {
		logError('scim: the token lookup failed', err)
		throw new ScimError(503, null, 'unavailable')
	}
}

async function route(request: Request, services: Services, actor: ScimActor): Promise<Response> {
	const url = new URL(request.url)
	const segments = url.pathname.slice(SCIM_BASE_PATH.length).split('/').filter((segment) => segment !== '')
	const [first, second, ...rest] = segments.map((segment) => decodeURIComponent(segment))
	const resource = first?.toLowerCase()
	if (resource === USERS && rest.length === 0) {
		return second === undefined ? users(request, services, actor, url) : user(request, services, actor, url, second)
	}
	const document = resource === undefined ? undefined : DISCOVERY[resource]
	if (document !== undefined && rest.length === 0) {
		if (request.method !== 'GET') return methodNotAllowed('GET')
		const body = document(locationBase(services), second)
		return body === null ? errorResponse(new ScimError(404, null, 'not found')) : scimJson(body)
	}
	return errorResponse(new ScimError(404, null, 'not found'))
}

async function users(request: Request, services: Services, actor: ScimActor, url: URL): Promise<Response> {
	if (request.method === 'GET') return list(services, url)
	if (request.method !== 'POST') return methodNotAllowed('GET, POST')
	const state = parseUserBody(await readBody(request), null)
	const { record } = await createUser(services, actor, state)
	const location = userLocation(services, record.id)
	return scimJson(userResource(record, stateOf(record), location), 201, { location })
}

async function user(request: Request, services: Services, actor: ScimActor, url: URL, id: string): Promise<Response> {
	const record = await services.repositories.scim.getRecord(id)
	if (record === null || !visible(services, record)) {
		return errorResponse(new ScimError(404, null, `user ${id} not found`))
	}
	const location = userLocation(services, record.id)
	const answer = async (next: ScimUserState) => {
		const saved = await saveUser(services, actor, record, next)
		return scimJson(userResource(saved, stateOf(saved), location))
	}
	switch (request.method) {
		case 'GET':
			return scimJson(userResource(record, stateOf(record), location))
		case 'PUT':
			return answer(parseUserBody(await readBody(request), stateOf(record)))
		case 'PATCH':
			return answer(applyPatch(await readBody(request), stateOf(record)))
		case 'DELETE':
			await deleteUser(services, actor, record)
			return new Response(null, { status: 204 })
	}
	return methodNotAllowed('GET, PUT, PATCH, DELETE')
}

/** `filter` is `<attribute> eq "<value>"` for `userName` or `externalId`; anything else is `invalidFilter`. */
const FILTER = /^\s*(username|externalid)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i

async function list(services: Services, url: URL): Promise<Response> {
	const startIndex = Math.max(1, positiveInteger(url.searchParams.get('startIndex')) ?? 1)
	const count = Math.min(MAX_PAGE_SIZE, positiveInteger(url.searchParams.get('count')) ?? MAX_PAGE_SIZE)
	const { scim } = services.repositories
	const filter = url.searchParams.get('filter')
	let total: number
	let records
	if (filter === null) {
		const page = await scim.listUsers(startIndex - 1, count, [...services.config.bootstrapAdmins])
		total = page.total
		records = page.records
	} else {
		const match = FILTER.exec(filter)
		if (match === null) throw new ScimError(400, 'invalidFilter', 'the filter supported is userName eq "…" or externalId eq "…"')
		const value = unquoted(match[2] ?? '')
		const all = match[1]?.toLowerCase() === 'username' ? await byUserName(services, value) : await scim.listByExternalId(value, MAX_PAGE_SIZE)
		const matched = all.filter((record) => visible(services, record))
		total = matched.length
		records = matched.slice(startIndex - 1, startIndex - 1 + count)
	}
	return scimJson({
		schemas: [LIST_RESPONSE_SCHEMA],
		totalResults: total,
		startIndex,
		itemsPerPage: records.length,
		Resources: records.map((record) => userResource(record, stateOf(record), userLocation(services, record.id))),
	})
}

/**
 * The user with this userName, or else the unprovisioned user whose mailbox it is: how a provider matches a person who
 * signed in before provisioning started, and then takes it over with a PATCH.
 */
async function byUserName(services: Services, userName: string) {
	const { scim } = services.repositories
	const named = await scim.getByUserName(userNameKey(userName))
	if (named !== null) return [named]
	const holder = await scim.getByMailbox(normalizeEmailIdentity(userName))
	return holder !== null && holder.linked_at === null ? [holder] : []
}

/** A filter's quoted value with its JSON escapes resolved. */
function unquoted(value: string): string {
	try {
		const parsed: unknown = JSON.parse(`"${value}"`)
		if (typeof parsed === 'string' && !hasControlCharacter(parsed)) return parsed
	} catch {
		// fall through
	}
	throw new ScimError(400, 'invalidFilter', 'the filter value is not a valid string, or holds a control character')
}

function positiveInteger(raw: string | null): number | null {
	if (raw === null || !/^\d{1,9}$/.test(raw)) return null
	return Number(raw)
}

async function readBody(request: Request): Promise<unknown> {
	const body = await readBoundedText(request, MAX_BODY_BYTES)
	if (!body.ok) {
		throw body.reason === 'too_large'
			? new ScimError(413, null, 'the request body is too large')
			: new ScimError(400, 'invalidSyntax', 'unreadable body')
	}
	try {
		return JSON.parse(body.text)
	} catch {
		throw new ScimError(400, 'invalidSyntax', 'the body is not JSON')
	}
}

function locationBase(services: Services): string {
	return `${services.config.issuer.replace(/\/+$/, '')}${SCIM_BASE_PATH}`
}

function userLocation(services: Services, id: string): string {
	return `${locationBase(services)}/Users/${encodeURIComponent(id)}`
}

function scimJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': `${SCIM_CONTENT_TYPE}; charset=utf-8`, 'cache-control': 'no-store', ...headers },
	})
}

function errorResponse(error: ScimError, headers: Record<string, string> = {}): Response {
	return scimJson(
		{ schemas: [ERROR_SCHEMA], status: String(error.status), ...(error.scimType === null ? {} : { scimType: error.scimType }), detail: error.message },
		error.status,
		headers,
	)
}

function methodNotAllowed(allow: string): Response {
	return errorResponse(new ScimError(405, null, 'method not allowed'), { allow })
}
