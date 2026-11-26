import type { CloudflareApiFetch } from '../../worker-secrets'

export interface FakeCloudflareAccount {
	/** The Custom Domains of the account: each hostname and the Worker it is attached to. */
	readonly customDomains?: ReadonlyArray<{ readonly hostname: string; readonly service: string }>
	/** The account's zones, by name; absent, every name asked for is a zone of the account. */
	readonly zones?: readonly string[]
	/** The DNS records of the account's zones. */
	readonly dnsRecords?: ReadonlyArray<{ readonly name: string; readonly type: string }>
	/** Every URL asked for, in order. */
	readonly seen?: string[]
	/** Every request's `authorization` header and redirect mode, in order. */
	readonly sent?: Array<{ readonly authorization: string | null; readonly redirect: RequestRedirect | undefined }>
}

const answer = (result: unknown): Response => Response.json({ success: true, errors: [], messages: [], result })

/** The Workers Custom Domains list answers as Cloudflare does: `errors` and `messages` null, with `result_info`. */
const customDomainsAnswer = (result: readonly unknown[]): Response =>
	Response.json({
		result,
		success: true,
		errors: null,
		messages: null,
		result_info: { page: 1, per_page: result.length, count: result.length, total_count: result.length },
	})

/** Cloudflare's API over a fake account, answering the reads the Custom Domain check makes. */
export function fakeCloudflareApi(account: FakeCloudflareAccount = {}): CloudflareApiFetch {
	return (url, init) => {
		account.seen?.push(url)
		account.sent?.push({ authorization: new Headers(init.headers).get('authorization'), redirect: init.redirect })
		const parsed = new URL(url)
		const path = parsed.pathname.replace('/client/v4', '')
		if (path.endsWith('/workers/domains')) {
			const hostname = parsed.searchParams.get('hostname')
			return Promise.resolve(customDomainsAnswer((account.customDomains ?? []).filter((domain) => domain.hostname === hostname)))
		}
		if (path === '/zones') {
			const name = parsed.searchParams.get('name') ?? ''
			const held = account.zones === undefined || account.zones.includes(name)
			return Promise.resolve(answer(held ? [{ id: `zone-${name}`, name }] : []))
		}
		if (path.endsWith('/dns_records')) {
			const name = parsed.searchParams.get('name')
			return Promise.resolve(answer((account.dnsRecords ?? []).filter((record) => record.name === name)))
		}
		return Promise.resolve(Response.json({ success: false, errors: [{ code: 7003, message: 'no route' }], result: null }, { status: 404 }))
	}
}
