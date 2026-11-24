// One parser of an object-storage connection (N5 in docs/ideas/cloud-providers.md), which Control's run logs,
// Operations' payloads and an application's files read under their own variable prefix: the bucket, the endpoint, the
// region, the addressing and where the credentials come from. Today's variables keep their meaning; `_ADDRESSING` and
// `_CREDENTIALS` are new and optional. A container cloud's task holds no long-lived key: with `_CREDENTIALS=container`
// the store reads short-lived ones from the ECS container credentials endpoint and refreshes them before they expire.
// Messages name variables, never a value: a key or an endpoint may be a credential.

/** Where a store's credentials come from. */
export type StorageCredentialSource =
	| { readonly kind: 'static'; readonly accessKeyId: string; readonly secretAccessKey: string }
	/** The ECS container credentials endpoint, at the path the container's environment names. */
	| { readonly kind: 'container'; readonly relativeUri: string }

export interface StorageConnection {
	readonly bucket: string
	/** Absent: the provider's default endpoint for the region (AWS S3). */
	readonly endpoint?: string
	readonly region: string
	/** `virtual` addresses `https://<bucket>.<host>`; `path` (the default, as before) `https://<host>/<bucket>`. */
	readonly addressing: 'path' | 'virtual'
	readonly credentials: StorageCredentialSource
}

export interface StorageConnectionOptions {
	/** The region a connection that names none signs for: what the caller signed for before the variable. */
	readonly defaultRegion: string
	/** Whether a static connection must name its endpoint (an application's always did). */
	readonly endpoint: 'required' | 'optional'
	/** The container's own environment, which holds the credentials endpoint's path; the process's by default. */
	readonly environment?: Readonly<Record<string, string | undefined>>
}

/** A connection the variables cannot describe; `problems` name variables only. */
export class StorageConnectionError extends Error {
	override readonly name = 'StorageConnectionError'
	constructor(readonly problems: readonly string[]) {
		super(`the object storage is not configured: ${problems.join('; ')}`)
	}
}

/** Whether `value` is a `StorageConnectionError`, read structurally: a caller in another package may hold another copy. */
export function storageConnectionProblems(value: unknown): readonly string[] | null {
	if (!(value instanceof Error) || value.name !== 'StorageConnectionError') return null
	const problems: unknown = Reflect.get(value, 'problems')
	return Array.isArray(problems) && problems.every((problem) => typeof problem === 'string') ? problems : null
}

/** A region name as S3-compatible stores spell them: `eu-central-1`, `auto`. */
const REGION = /^[a-z0-9][a-z0-9-]{0,31}$/
/** The path ECS writes: an absolute path, nothing that could name another host or climb out of it. */
const RELATIVE_URI = /^\/[A-Za-z0-9._~/-]{1,512}$/
const CONTAINER_URI_VARIABLE = 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'

/**
 * The connection the variables under `prefix` (`FABRIKA_APP_STORAGE`) describe, or `undefined` when none of them is
 * set. `<prefix>_BUCKET`, `_ENDPOINT`, `_REGION`, `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY` keep their meaning;
 * `_ADDRESSING` is `path` or `virtual`, `_CREDENTIALS` is `static` (the key pair, the default) or `container`, which
 * takes no key pair.
 */
export function parseStorageConnection(
	variables: Readonly<Record<string, string | undefined>>,
	prefix: string,
	options: StorageConnectionOptions,
): StorageConnection | undefined {
	const name = (suffix: string): string => `${prefix}_${suffix}`
	const value = (suffix: string): string => variables[name(suffix)]?.trim() ?? ''
	const suffixes = ['BUCKET', 'ENDPOINT', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'ADDRESSING', 'CREDENTIALS']
	if (suffixes.every((suffix) => value(suffix) === '')) {
		return undefined
	}
	const problems: string[] = []
	const region = value('REGION')
	if (region !== '' && !REGION.test(region)) {
		problems.push(`${name('REGION')} is not a region name (lowercase letters, digits and hyphens)`)
	}
	const addressing = value('ADDRESSING')
	if (addressing !== '' && addressing !== 'path' && addressing !== 'virtual') {
		problems.push(`${name('ADDRESSING')} is 'path' or 'virtual'`)
	}
	const mode = value('CREDENTIALS')
	if (mode !== '' && mode !== 'static' && mode !== 'container') {
		problems.push(`${name('CREDENTIALS')} is 'static' or 'container'`)
	}
	const bucket = value('BUCKET')
	if (bucket === '') {
		problems.push(`${name('BUCKET')} is not set`)
	}
	const endpoint = value('ENDPOINT')
	if (endpoint !== '' && !isEndpoint(endpoint)) {
		problems.push(`${name('ENDPOINT')} is not an http(s) origin`)
	}
	let credentials: StorageCredentialSource | undefined
	if (mode === 'container') {
		for (const suffix of ['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) {
			if (value(suffix) !== '') problems.push(`${name(suffix)} is set, but ${name('CREDENTIALS')} is 'container'`)
		}
		const relativeUri = (options.environment ?? process.env)[CONTAINER_URI_VARIABLE]?.trim() ?? ''
		if (!RELATIVE_URI.test(relativeUri) || relativeUri.includes('..') || relativeUri.startsWith('//')) {
			problems.push(`${name('CREDENTIALS')} is 'container', but ${CONTAINER_URI_VARIABLE} is not a path the container credentials endpoint serves`)
		} else {
			credentials = { kind: 'container', relativeUri }
		}
	} else {
		const missing = ['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', ...(options.endpoint === 'required' ? ['ENDPOINT'] : [])].filter((suffix) =>
			value(suffix) === ''
		)
		for (const suffix of missing) {
			problems.push(`${name(suffix)} is not set; the platform writes every ${prefix}_* variable together`)
		}
		if (missing.length === 0) {
			credentials = { kind: 'static', accessKeyId: value('ACCESS_KEY_ID'), secretAccessKey: value('SECRET_ACCESS_KEY') }
		}
	}
	if (problems.length > 0 || credentials === undefined) {
		throw new StorageConnectionError(problems)
	}
	return {
		bucket,
		...(endpoint === '' ? {} : { endpoint }),
		region: region === '' ? options.defaultRegion : region,
		addressing: addressing === 'virtual' ? 'virtual' : 'path',
		credentials,
	}
}

function isEndpoint(value: string): boolean {
	try {
		const url = new URL(value)
		return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
	} catch {
		return false
	}
}

/** A set of credentials a store signs with; `expiresAt` (epoch ms) only for short-lived ones. */
export interface StorageCredentials {
	readonly accessKeyId: string
	readonly secretAccessKey: string
	readonly sessionToken?: string
	readonly expiresAt?: number
}

/** The credentials a store signs its next request with. */
export interface CredentialProvider {
	current(): Promise<StorageCredentials>
}

export interface ContainerCredentialOptions {
	/** The endpoint's origin; ECS serves it at this link-local address. Tests point it elsewhere. */
	readonly origin?: string
	readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
	readonly now?: () => number
}

/** ECS's container credentials endpoint. */
export const CONTAINER_CREDENTIALS_ORIGIN = 'http://169.254.170.2'
/** How long before their expiry a set of credentials is replaced; ECS rotates them well before. */
export const CREDENTIAL_REFRESH_BEFORE_MS = 5 * 60_000
const CREDENTIAL_FETCH_TIMEOUT_MS = 5_000
const MAX_CREDENTIAL_BYTES = 16 * 1024

/**
 * Short-lived credentials from the ECS container credentials endpoint, fetched on first use and again within
 * `CREDENTIAL_REFRESH_BEFORE_MS` of their expiry, one fetch at a time. A refresh that fails while the held set is still
 * valid keeps it; once it expired, the store's next request fails. The answer decides what a request is signed with,
 * so no redirect is followed. Nothing logs a key, the token or the endpoint's path.
 */
export function containerCredentials(relativeUri: string, options: ContainerCredentialOptions = {}): CredentialProvider {
	const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
	const now = options.now ?? Date.now
	const url = `${options.origin ?? CONTAINER_CREDENTIALS_ORIGIN}${relativeUri}`
	let held: StorageCredentials | undefined
	let refreshing: Promise<StorageCredentials> | undefined
	const refresh = async (): Promise<StorageCredentials> => {
		const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(CREDENTIAL_FETCH_TIMEOUT_MS) })
		if (!response.ok) {
			await response.body?.cancel()
			throw new Error(`the container credentials endpoint answered ${response.status}`)
		}
		const text = await boundedText(response)
		const parsed = text === null ? null : parseContainerCredentials(text)
		if (parsed === null) {
			throw new Error('the container credentials endpoint answered no credentials')
		}
		return parsed
	}
	return {
		async current(): Promise<StorageCredentials> {
			const time = now()
			if (held !== undefined && (held.expiresAt === undefined || time < held.expiresAt - CREDENTIAL_REFRESH_BEFORE_MS)) {
				return held
			}
			refreshing ??= refresh().finally(() => {
				refreshing = undefined
			})
			try {
				held = await refreshing
				return held
			} catch {
				if (held?.expiresAt !== undefined && now() < held.expiresAt) {
					console.error('fabrika: the container credentials could not be refreshed; the held ones are still valid')
					return held
				}
				// A driver or parse error is not forwarded: nothing of the endpoint's answer reaches a log.
				throw new Error('the container credentials could not be read')
			}
		},
	}
}

async function boundedText(response: Response): Promise<string | null> {
	const bytes = await response.arrayBuffer()
	return bytes.byteLength > MAX_CREDENTIAL_BYTES ? null : new TextDecoder().decode(bytes)
}

/** The endpoint's answer, strictly: `AccessKeyId`, `SecretAccessKey`, `Token` and an ISO `Expiration`. */
function parseContainerCredentials(text: string): StorageCredentials | null {
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		return null
	}
	if (typeof body !== 'object' || body === null) return null
	const field = (key: string): unknown => Reflect.get(body, key)
	const accessKeyId = field('AccessKeyId')
	const secretAccessKey = field('SecretAccessKey')
	const token = field('Token')
	const expiration = field('Expiration')
	if (typeof accessKeyId !== 'string' || accessKeyId === '' || typeof secretAccessKey !== 'string' || secretAccessKey === '') return null
	if (typeof token !== 'string' || token === '' || typeof expiration !== 'string') return null
	const expiresAt = Date.parse(expiration)
	if (!Number.isFinite(expiresAt)) return null
	return { accessKeyId, secretAccessKey, sessionToken: token, expiresAt }
}

/** The credentials a connection names: its key pair as given, or the container endpoint's. */
export function credentialProvider(source: StorageCredentialSource, options: ContainerCredentialOptions = {}): CredentialProvider {
	if (source.kind === 'container') {
		return containerCredentials(source.relativeUri, options)
	}
	const fixed: StorageCredentials = { accessKeyId: source.accessKeyId, secretAccessKey: source.secretAccessKey }
	return { current: () => Promise.resolve(fixed) }
}
