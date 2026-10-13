/**
 * Cloudflare API helpers for the fabrika CLI — token verification, account resolution, and zone lookup.
 * These run from the operator's machine against the public CF API with the token from the environment;
 * the token VALUE is never logged here (only pass/fail + names).
 *
 * Local schemas validate the consumed fields while tolerating upstream additions.
 */

import { z } from 'zod'

const CF_API = 'https://api.cloudflare.com/client/v4'
const envelopeSchema = z.object({ success: z.boolean(), result: z.unknown(), errors: z.unknown() })
const errorSchema = z.object({ message: z.string() })
const tokenSchema = z.object({ status: z.literal('active') })
const namedResourceSchema = z.object({ id: z.string(), name: z.string() })
const entriesSchema = z.array(z.unknown())

function namedResources(value: unknown): CfAccount[] {
	const entries = entriesSchema.safeParse(value)
	if (!entries.success) return []
	return entries.data.flatMap((entry) => {
		const parsed = namedResourceSchema.safeParse(entry)
		return parsed.success ? [parsed.data] : []
	})
}

/** The CF account picked for this deploy (id + human name, for display). */
export interface CfAccount {
	id: string
	name: string
}

/** A resolved CF zone (registrable domain). */
export interface CfZone {
	id: string
	name: string
}

/** The first `errors[].message` from a CF envelope, or undefined — for a readable failure message. */
function firstErrorMessage(value: unknown): string | undefined {
	const errors = entriesSchema.safeParse(value)
	if (!errors.success) {
		return undefined
	}
	for (const entry of errors.data) {
		const parsed = errorSchema.safeParse(entry)
		if (parsed.success) {
			return parsed.data.message
		}
	}
	return undefined
}

/**
 * Parse the uniform CF envelope `{ success, result, errors }`, throwing a short message (never the
 * token) on a non-2xx / `success:false`. Returns the `result` field as `unknown` for the caller to
 * narrow. All field access is runtime-checked — no casts.
 */
async function cfJson(response: Response, what: string): Promise<unknown> {
	const parsed = envelopeSchema.safeParse(await response.json().catch(() => null))
	if (!parsed.success) {
		throw new Error(`${what}: unexpected Cloudflare response (HTTP ${response.status}).`)
	}
	const body = parsed.data
	if (!response.ok || !body.success) {
		throw new Error(`${what} failed: ${firstErrorMessage(body.errors) ?? `HTTP ${response.status}`}`)
	}
	return body.result
}

/** Authorization header for the token. Kept local so the value never leaks into a log statement. */
function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` }
}

/**
 * Best-effort token liveness check → true iff Cloudflare reports the token `active`. Tries the
 * ACCOUNT-scoped endpoint first when an account id is known: an ACCOUNT-OWNED token is NOT visible to
 * `/user/tokens/verify` (which returns "Invalid API Token" for it) — only `/accounts/<id>/tokens/verify`
 * sees it — then falls back to the user endpoint. NEVER throws: a `false` means "couldn't confirm", and
 * the caller decides whether to proceed (the real deploy is the ultimate check).
 */
export async function verifyToken(token: string, accountId?: string): Promise<boolean> {
	const endpoints = accountId !== undefined && accountId !== ''
		? [`${CF_API}/accounts/${accountId}/tokens/verify`, `${CF_API}/user/tokens/verify`]
		: [`${CF_API}/user/tokens/verify`]
	for (const endpoint of endpoints) {
		try {
			const response = await fetch(endpoint, { headers: authHeaders(token) })
			const result = await cfJson(response, 'Token verification')
			if (tokenSchema.safeParse(result).success) {
				return true
			}
		} catch {
			// Not fatal — the token may simply be the wrong TYPE for this endpoint; try the next.
		}
	}
	return false
}

/** List the accounts the token can act on: `GET /accounts`. */
export async function listAccounts(token: string): Promise<CfAccount[]> {
	const response = await fetch(`${CF_API}/accounts`, { headers: authHeaders(token) })
	const result = await cfJson(response, 'Listing accounts')
	return namedResources(result)
}

/**
 * The CF account to deploy into, from the accounts the token lists. An explicit id wins and does not
 * need to be listed — an account-owned token typically cannot list its own account. Without one, the
 * token must act on exactly one account; otherwise the error names them and the flag that picks one.
 */
export function selectAccount(accounts: readonly CfAccount[], accountId: string | undefined): CfAccount {
	if (accountId !== undefined) {
		return accounts.find((a) => a.id === accountId) ?? { id: accountId, name: '(from --account-id / CLOUDFLARE_ACCOUNT_ID)' }
	}
	const only = accounts[0]
	if (accounts.length === 1 && only !== undefined) {
		return only
	}
	if (accounts.length > 1) {
		throw new Error(
			`the token can act on ${accounts.length} Cloudflare accounts — pick one with --account-id=<id> or CLOUDFLARE_ACCOUNT_ID: `
				+ accounts.map((a) => `${a.name} (${a.id})`).join(', '),
		)
	}
	throw new Error(
		'the token lists no Cloudflare account (typical for an account-owned token) — pass --account-id=<id> or set '
			+ 'CLOUDFLARE_ACCOUNT_ID to the id in the dashboard URL',
	)
}

/**
 * Best-effort zone lookup for the registrable domain of `hostname`. Naively takes the last two
 * dot-labels (e.g. `fabrika.example.com` → `example.com`) and queries `GET /zones?name=<domain>`.
 * Returns the zone or null. The CLI WARNS on null (a custom-domain bind needs the zone) but never
 * fails on it — the operator may add the zone before the real deploy.
 */
export async function findZone(token: string, hostname: string): Promise<CfZone | null> {
	const domain = registrableDomain(hostname)
	const response = await fetch(`${CF_API}/zones?name=${encodeURIComponent(domain)}`, { headers: authHeaders(token) })
	const result = await cfJson(response, 'Zone lookup')
	const entries = entriesSchema.safeParse(result)
	if (!entries.success) {
		return null
	}
	const first = namedResourceSchema.safeParse(entries.data[0])
	return first.success ? first.data : null
}

/** Naive registrable-domain derivation: the last two dot-labels of a hostname. */
function registrableDomain(hostname: string): string {
	const labels = hostname.split('.').filter(Boolean)
	if (labels.length <= 2) {
		return labels.join('.')
	}
	return labels.slice(-2).join('.')
}
