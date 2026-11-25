// `ctx.notify(person, { title, body, path }, about)` (ADR-0088 §6): a notification for one person, written in the
// site's own transaction, so a rollback leaves none. `about` names what the recipient must hold to read the text: an
// action of the contract on one object (`{ action, on: { <dimension>: key } }`), or the action as a global grant
// (`{ action, app: true }`). It grants nothing and the writer needs none of it; the inbox checks the reader against it
// when the push arrives. So everything the inbox will read is checked here, before the row exists: a row the inbox
// could not check would fail every read of the person's inbox until it expired.

import { isCanonicalPath } from '@fabrika/auth-core'
import type { Notifications, Session } from '@fabrika/db/framework'
import { uuidv7 } from '@fabrika/platform'
import { NOTIFY_LIMITS } from '../contract/defaults'
import { CapabilityRefusedError } from './capability'

/** What the contract allows a notification to be about and to open, the same for every site of one `boot`. */
export interface NotifyRules {
	/** Whether the vocabulary declares `notifications: true`; without it `ctx.notify` only refuses. */
	readonly declared: boolean
	readonly actions: ReadonlySet<string>
	readonly dimensions: ReadonlySet<string>
	/** Whether a `GET` of `pathname` is served by one of the application's SPA mounts. */
	readonly opens: (pathname: string) => boolean
	/**
	 * Locates an object of a dimension a table owns, in the site's transaction; `null` for a dimension no table owns
	 * (a scope value, which the inbox checks against the grants alone).
	 */
	readonly locate: (dimension: string, key: string, using: Session) => Promise<unknown> | null
}

/** Where one site's `ctx.notify` writes: its transaction, bound to its request or attempt like every handle. */
export interface NotifySite {
	readonly site: string
	readonly tables: () => Notifications
	readonly session: () => Promise<Session>
	readonly check: () => void
}

export type Notify = (person: unknown, notification: unknown, about: unknown) => Promise<void>

/** `ctx.notify` of one site: it validates, then writes one row in the site's transaction; it sends nothing. */
export function notifier(rules: NotifyRules, site: NotifySite): Notify {
	if (!rules.declared) {
		return async () => {
			throw new CapabilityRefusedError(
				'undeclared_notify',
				`${site.site} notified a person, and the vocabulary declares no notifications: add notifications: true to it`,
			)
		}
	}
	return async (person: unknown, notification: unknown, about: unknown): Promise<void> => {
		site.check()
		const principal = textOf(site.site, 'the person', person, NOTIFY_LIMITS.principal, false)
		if (!isRecord(notification) || !hasOnly(notification, ['title', 'body', 'path'])) {
			throw refused(site.site, 'a notification is { title, body, path } and nothing else')
		}
		const title = textOf(site.site, 'title', notification['title'], NOTIFY_LIMITS.title, false)
		const body = textOf(site.site, 'body', notification['body'], NOTIFY_LIMITS.body, true)
		const path = pathOf(site.site, rules, notification['path'])
		const stored = aboutOf(site.site, rules, about)
		const session = await site.session()
		if (stored.dimension !== null) {
			// On Postgres a key the owning table cannot read (a UUID column handed another text) fails this statement, in
			// the writer's transaction, instead of every inbox read of the recipient. The data layer has no savepoint, so
			// the transaction is failed then and commits nothing, whether the handler catches this or not. A missing
			// object is still written: the inbox shows nothing about it, and refusing it would answer whether it exists.
			try {
				await rules.locate(stored.dimension, stored.value, session)
			} catch (error) {
				if (isDataException(error)) {
					throw refused(
						site.site,
						`the key of '${stored.dimension}' is not one its table can read, so this transaction is failed and commits nothing, caught or not`,
					)
				}
				throw error
			}
		}
		site.check()
		await site.tables().record(session, {
			id: uuidv7(),
			principal,
			title,
			body,
			path,
			about: stored,
			createdAt: Date.now(),
		})
	}
}

function refused(site: string, message: string): CapabilityRefusedError {
	return new CapabilityRefusedError('refused_notification', `${site}: ctx.notify: ${message}`)
}

/** `@fabrika/db`'s `DatabaseError` of a Postgres data exception (SQLSTATE class 22, a value the column cannot read), read by its fields. */
function isDataException(error: unknown): boolean {
	if (!(error instanceof Error) || error.name !== 'DatabaseError') {
		return false
	}
	const state: unknown = Reflect.get(error, 'sqlState')
	return typeof state === 'string' && state.startsWith('22')
}

/**
 * Bidirectional controls: on a lock screen, text another person typed could reorder how the rest of the line reads.
 * Other format characters stay, as emoji sequences and some scripts need them (U+200C, U+200D, the tag characters).
 */
function isBidiControl(code: number): boolean {
	return code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnly(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key))
}

/**
 * Plain text the device shows as it is: non-empty, well formed, at most `max` characters, no control character (a
 * body's line breaks apart, as `\n`) and no bidirectional control.
 */
function textOf(site: string, what: string, value: unknown, max: number, lines: boolean): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw refused(site, `${what} must be a non-empty text`)
	}
	let characters = 0
	for (const character of value) {
		characters++
		const code = character.codePointAt(0) ?? 0
		if ((code < 0x20 && !(lines && code === 0x0a)) || (code >= 0x7f && code <= 0x9f)) {
			throw refused(site, `${what} holds a control character${lines ? ' (a line break is \\n)' : ''}`)
		}
		// A lone surrogate is no character: the database would store a replacement for it, or refuse it.
		if (code >= 0xd800 && code <= 0xdfff) {
			throw refused(site, `${what} is not well-formed text`)
		}
		if (isBidiControl(code)) {
			throw refused(site, `${what} holds a bidirectional control character`)
		}
	}
	if (characters > max) {
		throw refused(site, `${what} is longer than ${max} characters`)
	}
	return value
}

/**
 * A same-origin path one of the application's SPA mounts serves, with an optional query: what the worker opens on a
 * click, and what it refuses to open otherwise.
 */
function pathOf(site: string, rules: NotifyRules, value: unknown): string {
	const path = textOf(site, 'path', value, NOTIFY_LIMITS.path, false)
	const question = path.indexOf('?')
	const pathname = question === -1 ? path : path.slice(0, question)
	if (path.includes('#') || !isCanonicalPath(pathname) || !rules.opens(pathname)) {
		throw refused(site, `path '${path}' is not a canonical path of one of the application's SPA mounts (a query may follow, no fragment)`)
	}
	return path
}

type StoredAbout =
	| { readonly action: string; readonly dimension: string; readonly value: string }
	| { readonly action: string; readonly dimension: null; readonly value: null }

/** `{ action, on: { <dimension>: key } }` or `{ action, app: true }`, of the contract's own actions and dimensions. */
function aboutOf(site: string, rules: NotifyRules, about: unknown): StoredAbout {
	const form = 'about is { action, on: { <dimension>: key } } or { action, app: true }'
	if (!isRecord(about) || typeof about['action'] !== 'string') {
		throw refused(site, form)
	}
	const action = about['action']
	if (!rules.actions.has(action)) {
		throw refused(site, `'${action}' is no action of the contract`)
	}
	if (hasOnly(about, ['action', 'app']) && about['app'] === true) {
		return { action, dimension: null, value: null }
	}
	const on = about['on']
	if (!hasOnly(about, ['action', 'on']) || !isRecord(on)) {
		throw refused(site, form)
	}
	const named = Object.keys(on)
	const [dimension] = named
	if (dimension === undefined || named.length !== 1) {
		throw refused(site, 'about.on names exactly one dimension and its key')
	}
	if (!rules.dimensions.has(dimension)) {
		throw refused(site, `'${dimension}' is no dimension of the contract`)
	}
	return { action, dimension, value: textOf(site, `the key of '${dimension}'`, on[dimension], NOTIFY_LIMITS.key, false) }
}
