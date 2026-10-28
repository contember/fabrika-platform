import { applicationMigrationUrl, applicationRuntimeUrl, PostgresMigrationError } from '@fabrika/platform-node'
import type { Bindable, Config } from 'oblaka-iac/src/types'
import { z } from 'zod'

// Postgres through Cloudflare Hyperdrive (ADR-0065): the provisioning credential stays in the runner. It reaches the
// application's own `fabrika db migrate` as an environment variable, and the runtime role's derived password reaches
// only the HTTPS body of the Hyperdrive API call. Neither is ever on an argv, in a log line, in an error or in the Worker.

/** The origin a Hyperdrive config connects to: the application's runtime role, on the host of the provisioning URL. */
export interface HyperdriveOrigin {
	readonly host: string
	readonly port: number
	readonly database: string
	readonly user: string
	readonly password: string
}

export interface HyperdriveUpsert {
	readonly accountId: string
	readonly apiToken: string
	readonly name: string
	readonly origin: HyperdriveOrigin
	readonly signal: AbortSignal
}

/** Creates or updates (PUT) the config named `name`, scheme postgres, caching { disabled: true }; reads back caching.disabled. Errors name the HTTP status and Cloudflare error codes only. */
export interface HyperdriveConfigs {
	upsert(input: HyperdriveUpsert): Promise<{ readonly id: string }>
}

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'

/** A Hyperdrive config's id, as Cloudflare hands it out and a Worker's binding names it. */
export const HYPERDRIVE_ID = /^[0-9a-f]{32}$/

/** More pages than any account lists: a server that keeps answering is refused, not followed forever. */
const MAX_LIST_PAGES = 100

const errorsSchema = z.array(z.object({ code: z.number() }).passthrough()).catch([])
const envelopeSchema = z.object({ success: z.boolean(), errors: errorsSchema.optional(), result: z.unknown() }).passthrough()
const listedSchema = z.array(z.object({ id: z.string(), name: z.string() }).passthrough())
const resultInfoSchema = z.object({
	page: z.number().optional(),
	per_page: z.number().optional(),
	total_count: z.number().optional(),
	total_pages: z.number().optional(),
}).passthrough()
const writtenSchema = z.object({
	id: z.string().regex(HYPERDRIVE_ID),
	name: z.string(),
	caching: z.object({ disabled: z.boolean().optional() }).passthrough().optional(),
}).passthrough()

/**
 * One Cloudflare API call. A failure names the operation, the HTTP status and Cloudflare's numeric error codes; never a
 * body, which may echo the request (and the origin's password in it).
 */
const callCloudflare = async (
	fetcher: HyperdriveFetch,
	operation: string,
	url: string,
	init: { readonly method: string; readonly apiToken: string; readonly body?: unknown; readonly signal: AbortSignal },
): Promise<{ readonly result: unknown; readonly resultInfo: unknown }> => {
	let response: Response
	try {
		response = await fetcher(url, {
			method: init.method,
			headers: {
				Authorization: `Bearer ${init.apiToken}`,
				...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			signal: init.signal,
		})
	} catch {
		throw new Error(`cloudflare: ${operation} did not reach the Cloudflare API`)
	}
	let decoded: unknown = null
	try {
		decoded = await response.json()
	} catch {
		decoded = null
	}
	const envelope = envelopeSchema.safeParse(decoded)
	if (!response.ok || !envelope.success || !envelope.data.success) {
		const codes = envelope.success ? (envelope.data.errors ?? []).map((error) => error.code) : []
		throw new Error(`cloudflare: ${operation} failed (HTTP ${response.status}${codes.length === 0 ? '' : `, Cloudflare error ${codes.join(', ')}`})`)
	}
	return { result: envelope.data.result, resultInfo: Reflect.get(envelope.data, 'result_info') }
}

const configsUrl = (accountId: string): string => `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/hyperdrive/configs`

/**
 * Whether the list has a page after `page`, by the server's own `result_info` as wrangler reads it: the server picks the
 * page size, so a short page is no last page. Without `result_info` the list is one page.
 */
const hasMorePages = (resultInfo: unknown, page: number, seen: number): boolean => {
	const info = resultInfoSchema.safeParse(resultInfo)
	if (!info.success) return false
	const { total_pages: totalPages, total_count: totalCount, per_page: perPage } = info.data
	if (totalPages !== undefined) return page < totalPages
	if (totalCount !== undefined && perPage !== undefined && perPage > 0) return page * perPage < totalCount
	if (totalCount !== undefined) return seen < totalCount
	return false
}

/**
 * The id of the account's Hyperdrive config named `name`, or null; two of that name are refused, not guessed between.
 * An empty page, or one that adds no config not already listed, ends the list: a server that ignores `page` repeats it.
 */
const findConfig = async (fetcher: HyperdriveFetch, input: HyperdriveUpsert): Promise<string | null> => {
	const seen = new Set<string>()
	const found = new Set<string>()
	for (let page = 1;; page++) {
		if (page > MAX_LIST_PAGES) throw new Error(`cloudflare: listing the Hyperdrive configs did not end within ${MAX_LIST_PAGES} pages`)
		const { result, resultInfo } = await callCloudflare(fetcher, 'listing the Hyperdrive configs', `${configsUrl(input.accountId)}?page=${page}`, {
			method: 'GET',
			apiToken: input.apiToken,
			signal: input.signal,
		})
		const listed = listedSchema.safeParse(result)
		if (!listed.success) throw new Error('cloudflare: listing the Hyperdrive configs returned an unreadable result')
		let added = false
		for (const config of listed.data) {
			if (seen.has(config.id)) continue
			seen.add(config.id)
			added = true
			if (config.name === input.name) found.add(config.id)
		}
		if (!added || !hasMorePages(resultInfo, page, seen.size)) break
	}
	if (found.size > 1) {
		throw new Error(`cloudflare: the account holds ${found.size} Hyperdrive configs named \`${input.name}\`; delete all but one`)
	}
	const [id] = found
	if (id !== undefined && !HYPERDRIVE_ID.test(id)) throw new Error(`cloudflare: the Hyperdrive config \`${input.name}\` has an unreadable id`)
	return id ?? null
}

/** What the Hyperdrive client calls the API with: `fetch`, or a test's stand-in. */
export type HyperdriveFetch = (url: string, init: RequestInit) => Promise<Response>

/** Cloudflare's Hyperdrive REST API over `fetcher`: list by name, then create (POST) or replace (PUT) with caching disabled. */
export const hyperdriveConfigsOver = (fetcher: HyperdriveFetch): HyperdriveConfigs => ({
	upsert: async (input) => {
		const existing = await findConfig(fetcher, input)
		const body = {
			name: input.name,
			origin: {
				scheme: 'postgres',
				host: input.origin.host,
				port: input.origin.port,
				database: input.origin.database,
				user: input.origin.user,
				password: input.origin.password,
			},
			// Sent on every write: a PUT without `caching` resets it to Cloudflare's default, which caches reads.
			caching: { disabled: true },
		}
		const operation = existing === null ? `creating the Hyperdrive config \`${input.name}\`` : `updating the Hyperdrive config \`${input.name}\``
		const { result } = await callCloudflare(
			fetcher,
			operation,
			existing === null ? configsUrl(input.accountId) : `${configsUrl(input.accountId)}/${existing}`,
			{ method: existing === null ? 'POST' : 'PUT', apiToken: input.apiToken, body, signal: input.signal },
		)
		const written = writtenSchema.safeParse(result)
		if (!written.success || written.data.name !== input.name || (existing !== null && written.data.id !== existing)) {
			throw new Error(`cloudflare: ${operation} returned an unreadable result`)
		}
		// A cached read would serve one request another's rows after a write; the data layer assumes none is cached.
		if (written.data.caching?.disabled !== true) {
			throw new Error(`cloudflare: the Hyperdrive config \`${input.name}\` does not read back with caching disabled`)
		}
		return { id: written.data.id }
	},
})

/** Cloudflare's Hyperdrive REST API (`https://api.cloudflare.com/client/v4/accounts/<id>/hyperdrive/configs`). */
export const cloudflareHyperdriveConfigs: HyperdriveConfigs = hyperdriveConfigsOver((url, init) => fetch(url, init))

/** Hyperdrive caps a config's name at 2048 characters; an environment and an app id are far shorter. */
const MAX_HYPERDRIVE_NAME = 2048
const HYPERDRIVE_NAME = /^[a-z0-9][a-z0-9-]*$/

/** The environment's Hyperdrive config: `<env>-<app>-database`, a name of the deployment's own, as oblaka's resources are. */
export const hyperdriveConfigName = (target: { readonly env: string; readonly appId: string }): string => {
	const name = `${target.env}-${target.appId}-database`
	if (!HYPERDRIVE_NAME.test(name) || name.length > MAX_HYPERDRIVE_NAME) {
		throw new Error(`cloudflare: \`${name}\` is not a Hyperdrive config name (lowercase letters, digits and -)`)
	}
	return name
}

const POSTGRES_PORT = 5432

/**
 * The runtime role's origin, from the provisioning URL: its host, port and database, the role `run_<id>` and the password
 * derived from the provisioning password (`applicationRuntimeUrl`). Errors never quote the URL.
 */
export const runtimeOrigin = (provisioningUrl: string, appId: string): HyperdriveOrigin => {
	const url = new URL(localDatabaseConnection(provisioningUrl, appId))
	if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
		throw new Error('cloudflare: the provisioning secret is not a postgres:// URL')
	}
	const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
	if (url.hostname === '' || database === '' || database.includes('/')) {
		throw new Error('cloudflare: the provisioning secret names no host or no database')
	}
	const port = url.port === '' ? POSTGRES_PORT : Number(url.port)
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('cloudflare: the provisioning secret names no valid port')
	return {
		host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
		port,
		database,
		user: decodeURIComponent(url.username),
		password: decodeURIComponent(url.password),
	}
}

/**
 * The runtime role's connection URL for a local run, where the Hyperdrive binding connects directly (lopata's
 * `localConnectionString`). Errors never quote the provisioning URL.
 */
export const localDatabaseConnection = (provisioningUrl: string, appId: string): string =>
	roleConnection(applicationRuntimeUrl, provisioningUrl, appId)

/**
 * The migration role's connection URL, which the application's `fabrika db migrate` derives and connects with: the
 * deploy scrubs it from that command's output. Errors never quote the provisioning URL.
 */
export const migrationDatabaseConnection = (provisioningUrl: string, appId: string): string =>
	roleConnection(applicationMigrationUrl, provisioningUrl, appId)

const roleConnection = (derive: (provisioningUrl: string, appId: string) => string, provisioningUrl: string, appId: string): string => {
	try {
		return derive(provisioningUrl, appId)
	} catch (error) {
		// The platform's own messages name no credential; anything else is withheld.
		const message = error instanceof PostgresMigrationError ? `: ${error.message}` : ''
		throw new Error(`cloudflare: the provisioning secret is not a usable Postgres URL${message}`)
	}
}

/** The id a generated config carries before `provision-database` handed one out: the check before the run, and a dry run. */
export const PENDING_HYPERDRIVE_ID = '00000000000000000000000000000000'

/** The Hyperdrive config's id, filled in by `provision-database` before oblaka writes the configs. */
export interface HyperdriveIdHolder {
	id: string | null
}

/** Writes hyperdrive: [{ binding, id: holder.id ?? PENDING_HYPERDRIVE_ID }] (or { id: 'local', localConnectionString } locally). */
export class HyperdriveDatabase implements Bindable {
	constructor(
		private readonly holder: HyperdriveIdHolder,
		private readonly local?: { readonly connectionString: string },
	) {}

	configureBinding(args: { config: Config; binding: string; env: string }): Config {
		const entry = this.local === undefined
			? { binding: args.binding, id: this.holder.id ?? PENDING_HYPERDRIVE_ID }
			: { binding: args.binding, id: 'local', localConnectionString: this.local.connectionString }
		return { ...args.config, hyperdrive: [...(args.config.hyperdrive ?? []), entry] }
	}
}
