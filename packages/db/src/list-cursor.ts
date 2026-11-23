// A list's cursor, signed with the database's own key (`fabrika_list_cursor_key`, which the framework migration writes
// once), so a cursor a client edited is the caller's `list_cursor`, never a statement the database refuses (a 500) or a
// page from a position no page ended at. A cursor is `<payload>.<signature>`: the payload is the base64url JSON of the
// last row's order values, and the signature an HMAC-SHA256 over the list it belongs to (its table and whole order) and
// the payload. The list is signed, not carried, so the cursor names no table or column.

import { parseList } from './builtins'
import { runFixedStatement, type Session } from './database'
import { QueryRefusedError } from './errors'
import type { DialectTexts } from './job-leases'
import { LIST_CURSOR_KEY_TABLE } from './migrations'

/** An order column's value as the database prints it: exact, where a `Date` would drop microseconds. */
export type CursorValue = string | null

const SQL_KEY: DialectTexts = {
	postgres: `select secret from ${LIST_CURSOR_KEY_TABLE} where id = 1`,
	sqlite: `select secret from ${LIST_CURSOR_KEY_TABLE} where id = 1`,
}

const BASE64URL = /^[A-Za-z0-9_-]+$/

/** The database's cursor key, read in `session`; the framework migration wrote it, so its absence is no caller's fault. */
async function cursorKey(session: Session): Promise<CryptoKey> {
	const [row] = await runFixedStatement(session, SQL_KEY[session.dialect], [])
	const secret: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'secret') : undefined
	if (typeof secret !== 'string' || secret.length === 0) {
		throw new QueryRefusedError('unexpected_row', `${LIST_CURSOR_KEY_TABLE} holds no key; the framework migrations did not run`)
	}
	return await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

function signed(list: string, payload: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(`fabrika-list-cursor\n${list}\n${payload}`)
}

/** The cursor of the page after the row whose order values are `values`, in the list `list` names. */
export async function signCursor(session: Session, list: string, values: readonly CursorValue[]): Promise<string> {
	const payload = Buffer.from(JSON.stringify(values)).toString('base64url')
	const signature = await crypto.subtle.sign('HMAC', await cursorKey(session), signed(list, payload))
	return `${payload}.${Buffer.from(signature).toString('base64url')}`
}

/**
 * The order values of `after` when it is a cursor this database signed for the list `list` names, with one plain value
 * per order column (`count`). Anything else is the caller's `list_cursor`: undecodable, unsigned, edited, of another
 * list or order, or of another shape.
 */
export async function openCursor(session: Session, list: string, after: unknown, count: number): Promise<readonly CursorValue[]> {
	const refused = () => new QueryRefusedError('list_cursor', 'after takes the next cursor of a page of this same list')
	if (typeof after !== 'string') {
		throw refused()
	}
	const [payload = '', given = '', ...rest] = after.split('.')
	if (rest.length > 0 || !BASE64URL.test(payload) || !BASE64URL.test(given)) {
		throw refused()
	}
	const signature = Buffer.from(given, 'base64url')
	// One spelling per signature: the last character's padding bits decode to nothing, and a cursor has exactly one.
	if (signature.toString('base64url') !== given) {
		throw refused()
	}
	if (!(await crypto.subtle.verify('HMAC', await cursorKey(session), new Uint8Array(signature), signed(list, payload)))) {
		throw refused()
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
	} catch {
		throw refused()
	}
	const values = parseList(parsed, (value): CursorValue => {
		if (typeof value === 'string' || value === null) {
			return value
		}
		throw refused()
	})
	if (values === undefined || values.length !== count) {
		throw refused()
	}
	return values
}
