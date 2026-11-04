// What a site's `egress` entry is, and which request URL it admits: the one rule the contract build, the artifact parser,
// the runtime guard on `fetch`, the checker and the approval diff share (ADR-0012 §15). An entry is an exact `https`
// origin or a pattern `https://*.<domain>[:port]` whose `*` stands for exactly one DNS label.

/** One parsed `egress` entry. `port` is `''` for the default port, as `URL.port` spells it. */
export type EgressEntry =
	| { readonly kind: 'origin'; readonly origin: string; readonly host: string; readonly port: string }
	| { readonly kind: 'pattern'; readonly pattern: string; readonly domain: string; readonly port: string }

export type EgressEntryParse = { readonly ok: true; readonly entry: EgressEntry } | { readonly ok: false; readonly problem: string }

/** What every pattern starts with: the scheme and the one wildcard label. */
const EGRESS_WILDCARD_PREFIX = 'https://*.'

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const NUMERIC_LABEL = /^[0-9]+$/

/**
 * `value` as an `egress` entry, or why it is none. Each entry is written canonically (lower case, punycode, no default
 * port, no trailing dot, no path), so an artifact names one entry one way; a problem names the canonical spelling when
 * there is one.
 */
export function parseEgressEntry(value: string): EgressEntryParse {
	return value.startsWith(EGRESS_WILDCARD_PREFIX) ? parsePattern(value) : parseOrigin(value)
}

function parseOrigin(value: string): EgressEntryParse {
	const url = urlOf(value)
	if (url === null || url.protocol !== 'https:') return refused('is not an https origin')
	if (url.hostname.endsWith('.')) return refused(canonicalProblem(url, `https://${url.host.replace(/\.(?=:|$)/, '')}`))
	if (!HOSTNAME.test(url.hostname)) {
		return refused(url.hostname.includes('*') ? 'puts a wildcard elsewhere than one leading label' : 'is not an https origin with a literal host')
	}
	if (url.origin !== value) return refused(canonicalProblem(url, url.origin))
	return { ok: true, entry: { kind: 'origin', origin: value, host: url.hostname, port: url.port } }
}

function parsePattern(value: string): EgressEntryParse {
	const rest = value.slice(EGRESS_WILDCARD_PREFIX.length)
	const url = urlOf(`https://${rest}`)
	if (url === null) return refused('is not an https origin pattern')
	if (url.hostname.includes('*')) return refused('has more than one wildcard label (allowed: one leading *.)')
	if (url.hostname.endsWith('.')) return refused(canonicalProblem(url, `${EGRESS_WILDCARD_PREFIX}${url.host.replace(/\.(?=:|$)/, '')}`))
	if (!HOSTNAME.test(url.hostname)) return refused('is not an https origin pattern with a literal domain')
	const labels = url.hostname.split('.')
	if (NUMERIC_LABEL.test(labels.at(-1) ?? '')) return refused('puts its wildcard on an IP address (allowed: a domain name)')
	if (isPublicSuffix(labels)) {
		return refused(`puts its wildcard on the public suffix '${url.hostname}' (allowed: a domain of your own, as in 'https://*.example.com')`)
	}
	if (url.origin !== `https://${rest}`) return refused(canonicalProblem(url, `${EGRESS_WILDCARD_PREFIX}${url.host}`))
	return { ok: true, entry: { kind: 'pattern', pattern: value, domain: url.hostname, port: url.port } }
}

/**
 * Whether `labels` name a public suffix by this rule, which stands in for the public suffix list (the platform ships no
 * copy of it): one label (`com`), or two labels under a two-letter country code whose first has at
 * most three characters (`co.uk`, `com.au`, `ne.jp`). A suffix this rule cannot tell, such as a longer second-level
 * label or a shared hosting domain, is the approver's to judge: the diff shows every pattern as a wider grant.
 */
function isPublicSuffix(labels: readonly string[]): boolean {
	if (labels.length < 2) return true
	const top = labels.at(-1) ?? ''
	const second = labels.at(-2) ?? ''
	return labels.length === 2 && /^[a-z]{2}$/.test(top) && second.length <= 3
}

/** Whether `url` is a request an entry of `entries` admits: its host and port, a trailing dot of the host aside. */
export function egressAdmits(entries: readonly EgressEntry[], url: URL): boolean {
	if (url.protocol !== 'https:') return false
	const host = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname
	return entries.some((entry) => entry.port === url.port && (entry.kind === 'origin' ? entry.host === host : isOneLabelUnder(host, entry.domain)))
}

/** `host` is exactly one non-empty label followed by `.<domain>`, so `evil-example.com` is not under `example.com`. */
function isOneLabelUnder(host: string, domain: string): boolean {
	const suffix = `.${domain}`
	if (!host.endsWith(suffix)) return false
	const label = host.slice(0, -suffix.length)
	return label.length > 0 && !label.includes('.')
}

function canonicalProblem(url: URL, canonical: string): string {
	const bare = url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === ''
	return bare ? `is not written canonically (write it as '${canonical}')` : 'carries a path, query or credentials (allowed: an origin only)'
}

function refused(problem: string): EgressEntryParse {
	return { ok: false, problem }
}

function urlOf(value: string): URL | null {
	try {
		return new URL(value)
	} catch {
		return null
	}
}
