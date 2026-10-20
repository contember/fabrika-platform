// Every default and every generated path of the contract, in one place. `buildArtifact` applies them; a reader of
// source reaches them only through `buildArtifact`, so both producers emit the same artifact.

import type { BodyAdmission, ChallengeProvider } from '@fabrika/auth-core'

export const CONTRACT_DEFAULTS = {
	/** A failed job run is not retried unless the job asks for it: a retry repeats work. */
	jobRetries: 0,
	importTimeoutMs: null,
} as const

/**
 * A procedure's bounds: its body (`maxBytes`, without files) and its handler's time (`timeoutMs`, counted after the last
 * body byte), each with its default and its ceiling, and the most calls a bucket admits per minute.
 */
export const PROCEDURE_LIMITS = {
	maxBytes: 64 * 1024,
	maxMaxBytes: 1024 * 1024,
	timeoutMs: 10_000,
	maxTimeoutMs: 60_000,
	maxPerMinute: 10_000,
	maxBytesPerHour: 64 * 1024 * 1024 * 1024,
	/** The body of a procedure with file fields: its default adds each field's files at its kind's `maxBytes`. */
	maxFileBodyBytes: 48 * 1024 * 1024,
	/** The files one request carries, at most: each field's `.max(n)` together. */
	maxFiles: 20,
	/** The headers of one part of a multipart body, at most. */
	maxPartHeaderBytes: 8 * 1024,
} as const

/**
 * A procedure with file fields is `multipart/form-data`: its JSON input travels in the first part, named `input`, and
 * each file in a part named after its field. A field of several files sends one part per file, under its name.
 */
export const FILE_INPUT_PART = 'input'

/**
 * A webhook's bounds: a provider's body, by default the most a procedure without files takes, since providers send
 * whole objects; up to what a procedure with file fields takes, since an inbound e-mail carries its attachments in the
 * body for the handler to `put`; and its handler's time, a procedure's.
 */
export const WEBHOOK_LIMITS = {
	maxBytes: PROCEDURE_LIMITS.maxMaxBytes,
	maxMaxBytes: PROCEDURE_LIMITS.maxFileBodyBytes,
	timeoutMs: PROCEDURE_LIMITS.timeoutMs,
} as const

/** A job attempt's time limit (`limits.timeoutMs`) and its ceiling, which keeps a lease and a timer within a day. */
export const JOB_LIMITS = {
	timeoutMs: 15 * 60_000,
	maxTimeoutMs: 24 * 60 * 60_000,
} as const

/** A public mutation's buckets per minute unless it declares its own: per client and for the endpoint. */
export const PUBLIC_MUTATION_RATE = { perClient: 10, perEndpoint: 100 } as const

/** What Turnstile admits as a widget's `action`: at most 32 letters, digits, `_` and `-`. */
export const CHALLENGE_ACTION = /^[A-Za-z0-9_-]{1,32}$/

/**
 * The challenge widget's `action` of a public procedure that declares none (`challenge.action`): its endpoint id with
 * `_` for `.`.
 */
export function challengeAction(endpoint: string): string {
	return endpoint.replaceAll('.', '_')
}

/** The input field that carries a challenge token; a procedure with a challenge declares it as a string. */
export const CHALLENGE_FIELD = 'challengeToken'

/** A procedure with file fields reads `multipart/form-data`; the proxy admits that type for its row. */
export { FORM_MULTIPART_TYPE } from '@fabrika/auth-core'

/** Each challenge provider's fixed browser origins: its widget's script and its frame. */
export const CHALLENGE_ORIGINS: Readonly<Record<ChallengeProvider, { readonly scriptSrc: readonly string[]; readonly frameSrc: readonly string[] }>> =
	{
		turnstile: { scriptSrc: ['https://challenges.cloudflare.com'], frameSrc: ['https://challenges.cloudflare.com'] },
	}

/**
 * The bounds of a file kind: the largest file a `scan: true` kind admits (the scanner reads at most this much of one
 * file, so a larger one could never be given a clean verdict).
 */
export const FILE_LIMITS = {
	maxScannedBytes: 100 * 1024 * 1024,
	/** Sniffable types a `scan: true` kind refuses: archives other than ZIP, whose contents the framework does not check. */
	unscannedTypes: ['application/gzip'] as readonly string[],
} as const

/**
 * The bounds of an `attachment()` output. `maxBytes` and `maxRows` are each attachment's own, at most these; a cell holds
 * at most `maxCellLength` UTF-16 code units, the most a spreadsheet cell keeps.
 */
export const ATTACHMENT_LIMITS = {
	maxBytes: 16 * 1024 * 1024,
	maxRows: 100_000,
	defaultMaxRows: 10_000,
	maxCellLength: 32_767,
} as const

/** The type each attachment format answers with. */
export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8'
export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

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

/**
 * The share SPA's bootstrap, served by the framework under the link prefix and loaded before any other script: it
 * takes the key out of the URL fragment and keeps it in a closure behind `SHARE_KEY_GLOBAL`.
 */
export const LINK_BOOTSTRAP_FILE = '__fabrika-share.js'
export const SHARE_KEY_GLOBAL = '__fabrikaShareKey'

/** What every `c.spa` mount serves under its prefix: the browser's Operations DSN and the release, as JSON. */
export const BROWSER_CONFIG_FILE = '__fabrika-config.json'

/** What every `c.spa` mount serves under its prefix to the person its access admitted: label, mailbox and actions. */
export const PAGE_CALLER_FILE = '__fabrika-me.json'

/** The row of an SPA mount's bare prefix (`GET /admin`), which redirects to the mount (`/admin/`). */
export function spaPrefixRowId(mount: string): string {
	return `${mount}.prefix`
}

/**
 * The value a generated endpoint access case sends in an input field that names a member the handler looks up
 * (`members` of `endpoint-access.fixtures.ts`); the endpoint access kit replaces it with a real member of the directory.
 */
export const GENERATED_MEMBER = 'fabrika:member'

/**
 * The value a generated endpoint access case sends in an input field that names an invitation the handler cancels
 * (`invitations` of `endpoint-access.fixtures.ts`); the endpoint access kit replaces it with one open in the target's value.
 */
export const GENERATED_INVITATION = 'fabrika:invitation'

/**
 * The value a generated endpoint access case sends in an input field that names a share link the handler revokes
 * (`links` of `endpoint-access.fixtures.ts`); the endpoint access kit replaces it with one the case's caller issued.
 */
export const GENERATED_LINK = 'fabrika:link'

/**
 * The prefix of the value a generated endpoint access case sends in an input field that names a row lying in its object
 * (`rows` of `endpoint-access.fixtures.ts`), followed by the row's table: `fabrika:row:note_comments`. The endpoint
 * access kit seeds one such row in each scope's object and sends that scope's key.
 */
export const GENERATED_ROW_PREFIX = 'fabrika:row:'

/**
 * The prefix of the value a generated endpoint access case sends in a file field, followed by the field's file kind:
 * `fabrika:file:attachments`. The endpoint access kit sends a small file of the kind's first type it can write in its place.
 */
export const GENERATED_FILE_PREFIX = 'fabrika:file:'

export const JSON_ADMISSION: BodyAdmission = { contentTypes: ['application/json'], maxBytes: null }

/** `/api` + `notes.list` → `/api/notes.list`; a root prefix does not double the `/`. */
export function joinPath(prefix: string, rest: string): string {
	return prefix === '/' ? `/${rest}` : `${prefix}/${rest}`
}

/**
 * The path of an RPC mount's procedure: its own `http.path` when it declares one (a public procedure only, which
 * `buildArtifact` checks), else `<prefix>/<dotted.path>`. The typed client calls the path the artifact's row carries.
 */
export function procedurePath(prefix: string, dotted: string, http: unknown): string {
	const own: unknown = typeof http === 'object' && http !== null ? Reflect.get(http, 'path') : undefined
	return typeof own === 'string' ? own : joinPath(prefix, dotted)
}
