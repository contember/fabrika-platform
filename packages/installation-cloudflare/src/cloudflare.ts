/**
 * Cloudflare API helpers for the fabrika CLI — token verification, account resolution, and zone lookup.
 * These run from the operator's laptop against the public CF API with the token the operator just
 * pasted; the token VALUE is never logged here (only pass/fail + names).
 *
 * Local schemas validate the consumed fields while tolerating upstream additions.
 */

import { required, select } from '@fabrika/installation-init'
import { z } from 'zod'
import { fromEnv } from './envfile'

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
 * Resolve the CF account to deploy into. If `preferred` is given and valid, use it; if the token can
 * act on exactly one account, use it; otherwise prompt the operator to pick. Throws if the token can
 * reach no account at all.
 */
export async function resolveAccountId(token: string, preferred?: string): Promise<CfAccount> {
	let accounts: CfAccount[] = []
	try {
		accounts = await listAccounts(token)
	} catch {
		accounts = []
	}
	// An explicit override wins: a `preferred` arg or CLOUDFLARE_ACCOUNT_ID from the environment.
	const wanted = preferred !== undefined && preferred !== '' ? preferred : fromEnv('CLOUDFLARE_ACCOUNT_ID')
	if (wanted !== undefined && wanted !== '') {
		return accounts.find((a) => a.id === wanted) ?? { id: wanted, name: '(from CLOUDFLARE_ACCOUNT_ID)' }
	}
	const only = accounts[0]
	if (accounts.length === 1 && only !== undefined) {
		return only
	}
	if (accounts.length > 1) {
		return select(
			'Which Cloudflare account should fabrika deploy into?',
			accounts.map((a) => ({ label: `${a.name} (${a.id})`, value: a })),
		)
	}
	// The token can't list any account (typical for an account-owned token) — ask for the id directly.
	const id = await required('Cloudflare account id (from the dashboard URL / Account Home)')
	return { id, name: '(entered)' }
}

/**
 * List the account's zones (`GET /zones?account.id=<id>`), used to SUGGEST a control-plane domain
 * (`fabrika.<zone>`). Best-effort: returns [] on any error (the token may lack Zone:Read), so the
 * caller then prompts for the domain with no default.
 */
export async function listZones(token: string, accountId: string): Promise<CfZone[]> {
	try {
		const response = await fetch(`${CF_API}/zones?account.id=${encodeURIComponent(accountId)}&per_page=50`, {
			headers: authHeaders(token),
		})
		const result = await cfJson(response, 'Listing zones')
		return namedResources(result)
	} catch {
		return []
	}
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
