// Every default and every generated path of the contract, in one place. `buildArtifact` applies them; a reader of
// source reaches them only through `buildArtifact`, so both producers emit the same artifact.

import type { BodyAdmission } from '@fabrika/auth-core'

export const CONTRACT_DEFAULTS = {
	/** A failed job run is not retried unless the job asks for it: a retry repeats work. */
	jobRetries: 0,
	formMaxBytes: 16 * 1024,
	webhookMaxBytes: 1024 * 1024,
	fileMaxPerOwner: null,
	fileLink: false,
	importTimeoutMs: null,
} as const

/** Generated file endpoints live under this prefix, for signed-in people. */
export const FILES_PREFIX = '/api'

/**
 * The bounds of a file collection: the largest file a `scan: true` collection admits (the scanner reads at most this
 * much of one file, so a larger one could never be given a clean verdict), and the pages of `files.<name>.list`.
 */
export const FILE_LIMITS = {
	maxScannedBytes: 100 * 1024 * 1024,
	listPageDefault: 50,
	listPageMax: 100,
} as const

/** Export procedures are served here, one path per procedure, and each export's description at its own path. */
export { CONNECT_PREFIX } from '@fabrika/auth-core'

/**
 * Every connector call has a deadline; it bounds the retries too. Queries are safe to retry. An answer and a
 * description are read under a byte budget, so another application cannot make the consumer buffer without bound.
 */
export const CONNECT_LIMITS = {
	defaultTimeoutMs: 3000,
	maxTimeoutMs: 10_000,
	retries: 2,
	maxAnswerBytes: 1024 * 1024,
	maxDescriptionBytes: 256 * 1024,
} as const

/** `products` version 1 → `products.v1`: the description's endpoint id, and the prefix of each procedure's. */
export function exportBase(name: string, version: number): string {
	return `${name}.v${version}`
}

/** A link mount serves its procedures under `<prefix>/api`; everything else under the prefix is its SPA. */
export const LINK_API_SEGMENT = 'api'

/** The path segment a webhook appends for the binding a delivery addresses. */
export const WEBHOOK_BINDING_PARAMETER = 'bindingId'

/** Generated webhook binding endpoints (`webhooks.<name>.bind`, `.unbind`) live under this prefix, for signed-in people. */
export const WEBHOOKS_PREFIX = '/api'

/** The input field of a binding endpoint that names the scope value the binding reaches. */
export const WEBHOOK_SCOPE_FIELD = 'scope'

/** A GitHub account a binding accepts: an App installation or a repository, by numeric id. */
export const WEBHOOK_ACCOUNT_PATTERN = '^(?:installation|repository):[1-9][0-9]{0,19}$'

/**
 * The share SPA's bootstrap, served by the framework under the link prefix and loaded before any other script: it
 * takes the key out of the URL fragment and keeps it in a closure behind `SHARE_KEY_GLOBAL`.
 */
export const LINK_BOOTSTRAP_FILE = '__fabrika-share.js'
export const SHARE_KEY_GLOBAL = '__fabrikaShareKey'

/** What every `c.spa` mount serves under its prefix: the browser's Operations DSN and the release, as JSON. */
export const BROWSER_CONFIG_FILE = '__fabrika-config.json'

export const JSON_ADMISSION: BodyAdmission = { contentTypes: ['application/json'], maxBytes: null }

/** `/api` + `notes.list` → `/api/notes.list`; a root prefix does not double the `/`. */
export function joinPath(prefix: string, rest: string): string {
	return prefix === '/' ? `/${rest}` : `${prefix}/${rest}`
}
