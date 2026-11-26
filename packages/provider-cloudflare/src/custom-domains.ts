// wrangler without a terminal publishes Custom Domains with `override_existing_origin` and `override_existing_dns_record`
// and cannot be told not to, so a deploy first asks Cloudflare who holds its hostname and refuses another Worker's
// Custom Domain or a DNS record wrangler would replace. The account token goes to Cloudflare's API only, never redirected.

import { z } from 'zod'
import type { CloudflareApiFetch } from './worker-secrets'

const CF_API = 'https://api.cloudflare.com/client/v4'

export interface CloudflareApi {
	readonly accountId: string
	readonly apiToken: string
	readonly fetch: CloudflareApiFetch
	readonly signal: AbortSignal
}

const envelopeSchema = z.object({
	success: z.boolean(),
	result: z.unknown(),
	errors: z.array(z.object({ code: z.number().optional(), message: z.string() }).passthrough()).optional(),
})
const customDomainsSchema = z.array(z.object({ hostname: z.string(), service: z.string() }).passthrough())
const zonesSchema = z.array(z.object({ id: z.string(), name: z.string() }).passthrough())
const dnsRecordsSchema = z.array(z.object({ name: z.string(), type: z.string() }).passthrough())

/** The record types a Custom Domain replaces at its hostname; MX, TXT, CAA and the rest stay beside it. */
const ADDRESS_RECORD_TYPES: ReadonlySet<string> = new Set(['A', 'AAAA', 'CNAME'])

/**
 * Refuse each hostname that the Worker `script` would take over: a Custom Domain of another Worker, or, where no Custom
 * Domain holds it yet, an A, AAAA or CNAME record of its zone. A hostname the Worker already holds as a Custom Domain is its own, and
 * its DNS record is the one Cloudflare manages for it.
 */
export async function assertCustomDomainsOwned(api: CloudflareApi, script: string, hostnames: readonly string[]): Promise<void> {
	for (const hostname of hostnames) {
		const customDomains = `reading the Custom Domains of ${hostname}`
		const attached = parsed(
			customDomainsSchema,
			await cloudflareResult(api, customDomains, `/accounts/${encodeURIComponent(api.accountId)}/workers/domains`, { hostname }),
			customDomains,
		).filter((domain) => domain.hostname.toLowerCase() === hostname)
		if (attached.some((domain) => domain.service !== script)) {
			throw new Error(
				`cloudflare: ${hostname} is a Custom Domain of another Worker; the deploy does not take it over. Detach it in Cloudflare, or give the environment another domain`,
			)
		}
		if (attached.length > 0) continue
		const zone = await zoneOf(api, hostname)
		if (zone === null) {
			throw new Error(`cloudflare: no zone of the account holds ${hostname}, so the deploy cannot tell who owns it; add the zone to the account`)
		}
		const dnsRecords = `reading the DNS records of ${hostname}`
		const records = parsed(
			dnsRecordsSchema,
			await cloudflareResult(api, dnsRecords, `/zones/${encodeURIComponent(zone)}/dns_records`, { name: hostname }),
			dnsRecords,
		).filter((record) => record.name.toLowerCase() === hostname && ADDRESS_RECORD_TYPES.has(record.type.toUpperCase()))
		const first = records[0]
		if (first !== undefined) {
			throw new Error(
				`cloudflare: ${hostname} already has a DNS record (${first.type}); the deploy does not replace it. Delete the record in Cloudflare, or give the environment another domain`,
			)
		}
	}
}

/** The id of the account's zone that holds `hostname`: the longest zone name it is or lies under, or null. */
async function zoneOf(api: CloudflareApi, hostname: string): Promise<string | null> {
	const labels = hostname.split('.')
	for (let start = 0; start < labels.length - 1; start++) {
		const name = labels.slice(start).join('.')
		const lookup = `looking up the zone ${name}`
		const zones = parsed(zonesSchema, await cloudflareResult(api, lookup, '/zones', { name, 'account.id': api.accountId }), lookup)
		const zone = zones.find((entry) => entry.name.toLowerCase() === name)
		if (zone !== undefined) return zone.id
	}
	return null
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
	const result = schema.safeParse(value)
	if (!result.success) throw new Error(`cloudflare: ${what}: unexpected response`)
	return result.data
}

/** One GET with the account token, no redirect followed; the envelope's `result`, or a refusal naming `what`. */
async function cloudflareResult(api: CloudflareApi, what: string, path: string, query: Readonly<Record<string, string>>): Promise<unknown> {
	const url = `${CF_API}${path}?${new URLSearchParams(query).toString()}`
	const response = await api.fetch(url, {
		method: 'GET',
		headers: { authorization: `Bearer ${api.apiToken}` },
		redirect: 'manual',
		signal: api.signal,
	})
	const parsed = envelopeSchema.safeParse(await response.json().catch(() => null))
	if (!parsed.success) throw new Error(`cloudflare: ${what}: unexpected response (HTTP ${response.status})`)
	if (!response.ok || !parsed.data.success) {
		const first = parsed.data.errors?.[0]
		const reason = first === undefined ? `HTTP ${response.status}` : `${first.code === undefined ? '' : `${first.code} `}${first.message}`
		throw new Error(`cloudflare: ${what} failed: ${reason}`)
	}
	return parsed.data.result
}
