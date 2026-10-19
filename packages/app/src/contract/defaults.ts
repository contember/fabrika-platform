// Every default and every generated path of the contract, in one place. `buildArtifact` applies them; a reader of
// source reaches them only through `buildArtifact`, so both producers emit the same artifact.

import type { BodyAdmission, ChallengeProvider } from '@fabrika/auth-core'

export const CONTRACT_DEFAULTS = {
	/** A failed job run is not retried unless the job asks for it: a retry repeats work. */
	jobRetries: 0,
	formMaxBytes: 16 * 1024,
	webhookMaxBytes: 1024 * 1024,
	fileMaxPerOwner: null,
	fileLink: false,
	importTimeoutMs: null,
} as const

/**
 * A form's admission, per minute and shared by every instance of the application: the requests it admits from one
 * client (`X-Fabrika-Client-Ip`) and the submissions it accepts in all. A form may declare its own `rate`, up to
 * `maxPerMinute` each.
 */
export const FORM_LIMITS = {
	perClient: 10,
	perForm: 100,
	maxPerMinute: 10_000,
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
} as const

/** A public mutation's buckets unless it declares its own: today's form limits, per client and for the endpoint. */
export const PUBLIC_MUTATION_RATE = { perClient: FORM_LIMITS.perClient, perEndpoint: FORM_LIMITS.perForm } as const

/**
 * The challenge widget's `action` of a public procedure: its endpoint id with `_` for `.`, as the provider admits at most
 * 32 letters, digits, `_` and `-`.
 */
export function challengeAction(endpoint: string): string {
	return endpoint.replaceAll('.', '_')
}

/** The input field that carries a form's challenge token; a form with a challenge declares it as a string. */
export const FORM_CHALLENGE_FIELD = 'challengeToken'

/**
 * A form that takes files is `multipart/form-data`: its input travels as JSON in the first part, named `input`, and each
 * file in a part named after its field. The proxy admits only that type for such a form.
 */
export { FORM_MULTIPART_TYPE } from '@fabrika/auth-core'
export const FORM_INPUT_PART = 'input'

/**
 * The bounds of a form's files: at most `maxFields` file fields, a file each; a received file waits `holdMs` for the
 * job that drains the inbox to attach it, then the sweep deletes it; a submission's body must arrive within
 * `timeoutMs`; a part's headers hold at most `maxPartHeaderBytes`.
 */
export const FORM_FILE_LIMITS = {
	maxFields: 4,
	holdMs: 7 * 24 * 60 * 60 * 1000,
	timeoutMs: 5 * 60 * 1000,
	maxPartHeaderBytes: 8 * 1024,
	/**
	 * A form with files accepts this many submissions per minute unless it declares `rate.perForm`, and its files write
	 * at most `bytesPerHour` per hour unless it declares `rate.bytesPerHour` (at most `maxBytesPerHour`). Each file
	 * reserves its collection's `maxBytes` before its first byte is written, and gives back what it did not use.
	 */
	perForm: 20,
	bytesPerHour: 512 * 1024 * 1024,
	maxBytesPerHour: 64 * 1024 * 1024 * 1024,
} as const

/** Each challenge provider's fixed browser origins: its widget's script and its frame. */
export const CHALLENGE_ORIGINS: Readonly<Record<ChallengeProvider, { readonly scriptSrc: readonly string[]; readonly frameSrc: readonly string[] }>> =
	{
		turnstile: { scriptSrc: ['https://challenges.cloudflare.com'], frameSrc: ['https://challenges.cloudflare.com'] },
	}

/** Generated file endpoints live under this prefix, for signed-in people. */
export const FILES_PREFIX = '/api'

/**
 * The bounds of a file collection: the largest file a `scan: true` collection admits (the scanner reads at most this
 * much of one file, so a larger one could never be given a clean verdict), and the pages of `files.<name>.list`.
 */
export const FILE_LIMITS = {
	maxScannedBytes: 100 * 1024 * 1024,
	/** Sniffable types a `scan: true` collection refuses: archives other than ZIP, whose contents the framework does not check. */
	unscannedTypes: ['application/gzip'] as readonly string[],
	listPageDefault: 50,
	listPageMax: 100,
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

export const JSON_ADMISSION: BodyAdmission = { contentTypes: ['application/json'], maxBytes: null }

/** `/api` + `notes.list` → `/api/notes.list`; a root prefix does not double the `/`. */
export function joinPath(prefix: string, rest: string): string {
	return prefix === '/' ? `/${rest}` : `${prefix}/${rest}`
}

/**
 * The paths of the endpoints of collection `name` under `base` (`FILES_PREFIX`, or a link mount's API prefix): the
 * upload takes `/:owner` after its path for a signed-in caller, and the download `/:fileId`.
 */
export function fileCollectionPaths(
	base: string,
	name: string,
): { readonly upload: string; readonly download: string; readonly list: string; readonly remove: string } {
	const at = joinPath(base, `files.${name}`)
	return { upload: `${at}.upload`, download: at, list: `${at}.list`, remove: `${at}.remove` }
}
