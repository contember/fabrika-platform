// AWS Signature Version 4 for the requests this package's clients send (ADR-0081): header signing of a request to one
// regional service endpoint, over Web Crypto so it runs on Bun and on Workers alike. It signs only what those clients
// need and refuses the rest: a path of unreserved characters (the JSON and query protocols post to `/`), no duplicate
// header, no line break in a value, no header the signer owns, and `http:` only where the caller allows it (a local
// emulator). `presignGet` signs S3's presigned read in the query, on the same path rules (`Bun.S3Client`'s presign is
// not used: on Bun 1.4.4 a virtual-hosted client with a bucketless endpoint drops the bucket from the URL).
//
// Pinned by the known-answer tests in `__tests__/sigv4.test.ts`, from AWS's published Signature Version 4 test suite.
// This is security-critical code: a change to it is reviewed as one. No error here quotes a header value, a body, a
// signature or a credential.

/** The algorithm a signature names. */
export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256'

/** The credentials a request is signed with: a key pair and, for a role's temporary credentials, its session token. */
export interface SigningCredentials {
	readonly accessKeyId: string
	readonly secretAccessKey: string
	readonly sessionToken?: string
}

/** Where the signature is valid: one service in one region. */
export interface SigningScope {
	readonly region: string
	readonly service: string
}

/** A request to sign, as its client builds it. */
export interface SignableRequest {
	/** `PUT` and `DELETE` are S3's (a part's upload, an upload's abort); the JSON and query protocols post. */
	readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
	/** The endpoint's origin, `https://ecs.eu-central-1.amazonaws.com`; `http:` only with `allowInsecureOrigin`. */
	readonly origin: string
	/** The path, unencoded: `/`, or segments of unreserved characters. */
	readonly path: string
	/** Query parameters, unencoded; the signer encodes and orders them. */
	readonly query?: readonly (readonly [string, string])[]
	/** The headers to sign and send, beside the ones the signer adds. Names are case-insensitive and must be unique. */
	readonly headers?: Readonly<Record<string, string>>
	readonly body?: string | Uint8Array
}

export interface SigningOptions {
	/** Send the body's digest as `x-amz-content-sha256` and sign it (S3's form); the JSON and query protocols need not. */
	readonly bodyDigestHeader?: boolean
	/**
	 * Sign for an `http:` origin: a local emulator only, which the composition names. Without it an `http:` origin is
	 * refused, so a misconfigured endpoint never carries the authorization, a session token or the body without TLS.
	 */
	readonly allowInsecureOrigin?: boolean
}

/** What to send: the URL with its canonical query, and every header, the signer's included. Host is the URL's. */
export interface SignedRequest {
	readonly url: string
	readonly headers: { readonly authorization: string; readonly [name: string]: string }
}

/** The canonical form of a request, the first stage of a signature. */
export interface CanonicalRequest {
	readonly text: string
	readonly signedHeaders: string
}

/** The headers the signer sets itself; a caller's header of one of these names is refused. */
const SIGNER_HEADERS: ReadonlySet<string> = new Set(['authorization', 'host', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256'])
/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** A header value this signer takes: visible ASCII, spaces and tabs, no line break or other control character. */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/
/** A path segment that encodes to itself, so single and double encoding agree. */
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/
/** A region or service name as it appears in a credential scope. */
const SCOPE_PART = /^[a-z0-9-]{1,64}$/
/**
 * An access key id as the signer takes it: letters and digits, which cannot break the `Credential=` field. AWS's own
 * form (upper case, 16 or more) is for the code that loads real credentials to check; the published test suite's
 * `AKIDEXAMPLE` and a local emulator's `test` must sign.
 */
const ACCESS_KEY_ID = /^[A-Za-z0-9]{1,128}$/

const encoder = new TextEncoder()

/** Refuses a request this signer does not sign, naming the part, never its value. */
function refuse(part: string): never {
	throw new Error(`the AWS request cannot be signed: ${part}`)
}

/** URI-encodes `value` as SigV4 asks: every byte but `A-Za-z0-9-._~` as `%XX`, upper-case hex, space as `%20`. */
export function encodeRfc3986(value: string): string {
	let encoded: string
	try {
		encoded = encodeURIComponent(value)
	} catch {
		return refuse('a query parameter is not well-formed Unicode')
	}
	return encoded.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
	return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The lower-case hex SHA-256 of `data`. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
	// A copy, so a view over a shared or larger buffer is digested as exactly its own bytes.
	return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data)))
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
	const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)))
}

/** `20150830T123600Z`: the ISO 8601 basic form, to the second, in UTC. */
export function amzDate(at: Date): string {
	if (Number.isNaN(at.getTime())) return refuse('the signing time is not a date')
	return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** The canonical path: `/` as it is, otherwise each segment of unreserved characters, which encodes to itself. */
function canonicalPath(path: string): string {
	if (path === '/') return path
	if (!path.startsWith('/')) return refuse('the path is not absolute')
	const segments = path.slice(1).split('/')
	// A trailing slash leaves one empty last segment, which is kept; any other empty, `.` or `..` segment is refused
	// rather than normalized, so the path signed is the path sent.
	const last = segments.length - 1
	for (const [index, segment] of segments.entries()) {
		if (segment === '' && index === last) continue
		if (segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment)) {
			return refuse('the path has a segment outside the unreserved characters')
		}
	}
	return path
}

/** The canonical query: each name and value encoded, ordered by name, then by value. */
function canonicalQuery(query: readonly (readonly [string, string])[]): string {
	return query
		.map(([name, value]): readonly [string, string] => [encodeRfc3986(name), encodeRfc3986(value)])
		.sort(([nameA, valueA], [nameB, valueB]) => (nameA < nameB ? -1 : nameA > nameB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0))
		.map(([name, value]) => `${name}=${value}`)
		.join('&')
}

/** A header value as signed: trimmed, each run of spaces and tabs made one space, as the SDKs sign it. */
function canonicalValue(value: string): string {
	return value.trim().replace(/[ \t]+/g, ' ')
}

/** The canonical request over a path and a query already in their canonical form. */
function canonicalText(
	method: string,
	path: string,
	search: string,
	headers: Readonly<Record<string, string>>,
	bodySha256: string,
): CanonicalRequest {
	const names = Object.keys(headers).sort()
	const lines = names.map((name) => `${name}:${canonicalValue(headers[name] ?? '')}\n`).join('')
	const signedHeaders = names.join(';')
	return { text: `${method}\n${path}\n${search}\n${lines}\n${signedHeaders}\n${bodySha256}`, signedHeaders }
}

/**
 * The canonical request of `method`, `path` and `query` with exactly `headers` (lower-case names, the signer's own
 * included) and a body of digest `bodySha256`. Every header given is signed.
 */
export function canonicalRequest(
	method: string,
	path: string,
	query: readonly (readonly [string, string])[],
	headers: Readonly<Record<string, string>>,
	bodySha256: string,
): CanonicalRequest {
	return canonicalText(method, canonicalPath(path), canonicalQuery(query), headers, bodySha256)
}

/** The credential scope: `<date>/<region>/<service>/aws4_request`. */
export function credentialScope(date: string, scope: SigningScope): string {
	return `${date}/${scope.region}/${scope.service}/aws4_request`
}

/** The string to sign over a canonical request. */
export async function stringToSign(stamp: string, scope: SigningScope, canonical: string): Promise<string> {
	return `${SIGV4_ALGORITHM}\n${stamp}\n${credentialScope(stamp.slice(0, 8), scope)}\n${await sha256Hex(canonical)}`
}

/** The signing key: `AWS4<secret>` through the date, the region, the service and `aws4_request`. */
export async function signingKey(secretAccessKey: string, date: string, scope: SigningScope): Promise<Uint8Array<ArrayBuffer>> {
	const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), date)
	const regionKey = await hmac(dateKey, scope.region)
	const serviceKey = await hmac(regionKey, scope.service)
	return hmac(serviceKey, 'aws4_request')
}

/** The hex signature of `toSign` under the key of `secretAccessKey` for `date` and `scope`. */
export async function signature(secretAccessKey: string, date: string, scope: SigningScope, toSign: string): Promise<string> {
	return hex(await hmac(await signingKey(secretAccessKey, date, scope), toSign))
}

/** The origin's `URL`, refused unless it is a bare `https:` origin, or `http:` where `insecure` allows it. */
function endpointUrl(origin: string, insecure: boolean): URL {
	let url: URL
	try {
		url = new URL(origin)
	} catch {
		return refuse('the origin is not a URL')
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin) return refuse('the origin is not a bare http(s) origin')
	if (url.protocol === 'http:' && !insecure) return refuse('the origin is http: without allowInsecureOrigin')
	return url
}

/** Refuses a scope or a set of credentials the signer does not sign with, naming the part, never its value. */
function checkScopeAndCredentials(scope: SigningScope, credentials: SigningCredentials): void {
	if (!SCOPE_PART.test(scope.region) || !SCOPE_PART.test(scope.service)) refuse('the region or service is not a scope name')
	if (!ACCESS_KEY_ID.test(credentials.accessKeyId)) refuse('the access key id is not one')
	if (credentials.secretAccessKey === '') refuse('the secret access key is empty')
	if (credentials.sessionToken === '') refuse('the session token is empty')
	if (credentials.sessionToken !== undefined && !HEADER_VALUE.test(credentials.sessionToken)) refuse('the session token has a control character')
}

/** The longest validity of a presigned URL SigV4 allows: seven days. */
export const MAX_PRESIGNED_SECONDS = 7 * 24 * 60 * 60

/**
 * A presigned `GET` of `path` at `origin`: the URL whose query carries the signature (`X-Amz-*`), valid
 * `expiresInSeconds` from `at`, signing the `host` header only and an unsigned payload, as S3 takes it. A session token
 * travels in the signed query. The URL is a credential: it opens that one object until it expires.
 */
export async function presignGet(
	request: { readonly origin: string; readonly path: string },
	credentials: SigningCredentials,
	scope: SigningScope,
	at: Date,
	expiresInSeconds: number,
	options: { readonly allowInsecureOrigin?: boolean } = {},
): Promise<string> {
	checkScopeAndCredentials(scope, credentials)
	if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_PRESIGNED_SECONDS) refuse('the expiry is out of bounds')
	const { accessKeyId, secretAccessKey, sessionToken } = credentials
	const signedScope: SigningScope = { region: scope.region, service: scope.service }
	const url = endpointUrl(request.origin, options.allowInsecureOrigin === true)
	const path = canonicalPath(request.path)
	const stamp = amzDate(at)
	const date = stamp.slice(0, 8)
	const query: (readonly [string, string])[] = [
		['X-Amz-Algorithm', SIGV4_ALGORITHM],
		['X-Amz-Credential', `${accessKeyId}/${credentialScope(date, signedScope)}`],
		['X-Amz-Date', stamp],
		['X-Amz-Expires', String(expiresInSeconds)],
		['X-Amz-SignedHeaders', 'host'],
	]
	if (sessionToken !== undefined) query.push(['X-Amz-Security-Token', sessionToken])
	const search = canonicalQuery(query)
	const canonical = canonicalText('GET', path, search, { host: url.host }, 'UNSIGNED-PAYLOAD')
	const signed = await signature(secretAccessKey, date, signedScope, await stringToSign(stamp, signedScope, canonical.text))
	return `${url.origin}${path}?${search}&X-Amz-Signature=${signed}`
}

/** The caller's headers under lower-case names, refused when one repeats, is the signer's own, or has a line break. */
function callerHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
	// A map, so a name such as `constructor` or `__proto__` is a header like any other, not an object's own machinery.
	const lowered = new Map<string, string>()
	for (const [name, value] of Object.entries(headers)) {
		if (!HEADER_NAME.test(name)) refuse('a header name is not a token')
		const lower = name.toLowerCase()
		if (SIGNER_HEADERS.has(lower)) refuse(`the signer sets ${lower} itself`)
		if (lowered.has(lower)) refuse(`the header ${lower} is given twice`)
		if (!HEADER_VALUE.test(value)) refuse(`the header ${lower} has a control character`)
		lowered.set(lower, value)
	}
	return Object.fromEntries(lowered)
}

/**
 * Signs `request` with `credentials` for `scope` at `at`: answers the URL to fetch and the headers to send with it,
 * `authorization`, `x-amz-date` and, for temporary credentials, `x-amz-security-token` among them.
 */
export async function signRequest(
	request: SignableRequest,
	credentials: SigningCredentials,
	scope: SigningScope,
	at: Date,
	options: SigningOptions = {},
): Promise<SignedRequest> {
	checkScopeAndCredentials(scope, credentials)
	// Everything the request and the credentials say is read here, before the first await, and used as read: the URL
	// sent carries the very path and query that were signed, whatever the caller changes meanwhile.
	const { accessKeyId, secretAccessKey, sessionToken } = credentials
	const signedScope: SigningScope = { region: scope.region, service: scope.service }
	const method = request.method
	const url = endpointUrl(request.origin, options.allowInsecureOrigin === true)
	const path = canonicalPath(request.path)
	const search = canonicalQuery(request.query ?? [])
	const sent = callerHeaders(request.headers ?? {})
	const stamp = amzDate(at)
	const digest = sha256Hex(request.body ?? '')
	const bodySha256 = await digest
	sent['x-amz-date'] = stamp
	if (sessionToken !== undefined) sent['x-amz-security-token'] = sessionToken
	if (options.bodyDigestHeader === true) sent['x-amz-content-sha256'] = bodySha256
	const canonical = canonicalText(method, path, search, { ...sent, host: url.host }, bodySha256)
	const toSign = await stringToSign(stamp, signedScope, canonical.text)
	const date = stamp.slice(0, 8)
	const signed = await signature(secretAccessKey, date, signedScope, toSign)
	const credential = `${accessKeyId}/${credentialScope(date, signedScope)}`
	const authorization = `${SIGV4_ALGORITHM} Credential=${credential}, SignedHeaders=${canonical.signedHeaders}, Signature=${signed}`
	return { url: `${url.origin}${path}${search === '' ? '' : `?${search}`}`, headers: { ...sent, authorization } }
}
