// A repeated mutation answered from its receipt (ADR-0078). A request that carries `Idempotency-Key` is keyed by its
// principal and that key; the receipt records the operation, the SHA-256 of the request's canonical input and the
// output's JSON, written in the invocation's transaction before its commit. The dispatcher reads it after every check
// that refuses the request before the handler, and answers a match without running the handler.

import { type EndpointRow, isAttachmentShape, isFileShape, isRedirectShape } from '@fabrika/auth-core'
import { fileHoldingOf, type RequestReceipt, type RequestReceipts, type Session } from '@fabrika/db/framework'
import { z } from 'zod/v4'
import type { Schema } from '../contract/define'
import { HttpError, jsonResponse } from '../errors'
import type { FileWork } from '../files/kinds'
import { zodSchemaOf } from '../schema/data-schema'
import { ServerFault } from './faults'
import { project, ProjectionRefusedError } from './project'

/** The header a client marks a repeatable request with: the IETF HTTP API working group's name. */
export const REQUEST_KEY_HEADER = 'Idempotency-Key'

/** A receipt answers for at least this long; each receipt write prunes a batch of older ones. */
export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

/** The most a stored output may take, as UTF-8 JSON. */
export const MAX_RECEIPT_BYTES = 65_536

const KEY = /^[A-Za-z0-9._~:-]{1,128}$/

/** The request's key, bare or as a quoted string; `null` without the header. A malformed one is a 400. */
export function requestKeyOf(request: Request): string | null {
	const header = request.headers.get(REQUEST_KEY_HEADER)
	if (header === null) {
		return null
	}
	const value = header.trim()
	const key = value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
	if (!KEY.test(key)) {
		throw new HttpError(400, 'request_key_invalid', `${REQUEST_KEY_HEADER} is 1-128 characters of A-Z a-z 0-9 . _ ~ : -`)
	}
	return key
}

/** Whether an endpoint's answer can be stored and replayed: JSON, not a file, an attachment or a redirect. */
export function answersJson(row: EndpointRow): boolean {
	const output = row.output
	return output === null || !(isFileShape(output) || isAttachmentShape(output) || isRedirectShape(output))
}

/** One keyed request of a mutation: whose key it is, and where its receipt is read and written. */
export interface KeyedRequest {
	readonly receipts: RequestReceipts
	readonly principal: string
	readonly key: string
}

/**
 * A value as one unambiguous text: every value tagged by its kind, object keys sorted, array order kept, an absent field
 * left out. A file of the input is its kind, type, size and the digest of its bytes, never its pending id.
 */
function canonical(value: unknown, work: FileWork, where: string): string {
	if (value === null) {
		return 'z'
	}
	switch (typeof value) {
		case 'string':
			return `s${JSON.stringify(value)}`
		case 'boolean':
			return value ? 't' : 'f'
		case 'number':
			if (!Number.isFinite(value)) {
				throw new ServerFault('request_identity_unsupported', `${where}: the input holds a number that is not finite`)
			}
			return `n${JSON.stringify(value)}`
		case 'bigint':
			return `b${value.toString()}`
		case 'object':
			break
		default:
			throw new ServerFault('request_identity_unsupported', `${where}: the input holds a ${typeof value}, which has no identity`)
	}
	const holding = fileHoldingOf(value)
	if (holding !== undefined) {
		const digest = work.digestOf(holding.id)
		if (digest === null) {
			throw new ServerFault('request_identity_unsupported', `${where}: the input holds a file this request did not upload`)
		}
		const text = (field: string): string | null => {
			const read: unknown = Reflect.get(value, field)
			return typeof read === 'string' ? read : null
		}
		const size: unknown = Reflect.get(value, 'size')
		return `F${JSON.stringify([holding.kind, text('name'), text('type'), typeof size === 'number' ? size : null, digest])}`
	}
	if (value instanceof Date) {
		return `d${JSON.stringify(Number.isNaN(value.getTime()) ? null : value.toISOString())}`
	}
	if (Array.isArray(value)) {
		return `a[${value.map((item: unknown) => canonical(item, work, where)).join(',')}]`
	}
	const prototype: unknown = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ServerFault('request_identity_unsupported', `${where}: the input holds an object that is not plain data`)
	}
	const fields = Object.entries(value)
		.filter(([, field]) => field !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, field]) => `${JSON.stringify(name)}:${canonical(field, work, where)}`)
	return `o{${fields.join(',')}}`
}

/** The SHA-256 (hex) of the request's canonical input and `query`: what tells two requests under one key apart. */
export async function requestIdentity(input: unknown, query: unknown, work: FileWork, where: string): Promise<string> {
	const text = canonical({ input, query }, work, where)
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** JSON with object keys sorted, for comparing two answers whatever order their keys were written in. */
function sortedJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(sortedJson).join(',')}]`
	}
	if (typeof value === 'object' && value !== null) {
		const fields = Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([name, field]) => `${JSON.stringify(name)}:${sortedJson(field)}`)
		return `{${fields.join(',')}}`
	}
	return JSON.stringify(value)
}

/** The output, projected and validated whole, as `outputResponse` answers it. */
export function validatedOutput(row: EndpointRow, schema: Schema, result: unknown): unknown {
	let projected: unknown
	try {
		projected = project(schema, result)
	} catch (error) {
		if (error instanceof ProjectionRefusedError) {
			throw new ServerFault('output_refused', `'${row.id}' returned a value no branch of its output union accepts`)
		}
		throw error
	}
	const output = z.safeParse(zodSchemaOf(schema), projected)
	if (!output.success) {
		throw new ServerFault('output_refused', `'${row.id}' returned a value its output schema refuses`)
	}
	return output.data
}

/**
 * The answer of a receipt the key already has: the stored output when the operation and the input are this request's,
 * and the current output schema answers it unchanged. Anything else is a 409, and nothing runs.
 */
export function replayed(row: EndpointRow, schema: Schema, stored: RequestReceipt, identity: string): Response {
	if (stored.operation !== row.id || stored.identity !== identity) {
		throw new HttpError(409, 'request_key_reused', `${REQUEST_KEY_HEADER} was used for another request; send a new key for a new request`)
	}
	const incompatible = () =>
		new HttpError(409, 'request_replay_incompatible', `The stored answer of this request no longer fits '${row.id}'; read the current state`)
	const body: unknown = JSON.parse(stored.output)
	if (typeof body !== 'object' || body === null) {
		throw incompatible()
	}
	// The stored answer was projected once already; a second projection could pick another branch of a union.
	const output = z.safeParse(zodSchemaOf(schema), Reflect.get(body, 'result'))
	// What the client would read: the answer as JSON, compared with the stored one.
	if (!output.success || sortedJson(JSON.parse(JSON.stringify({ result: output.data }))) !== sortedJson(body)) {
		throw incompatible()
	}
	return jsonResponse({ result: output.data }, 200)
}

/**
 * Records the answer of a keyed request in `session`, the invocation's transaction, and answers it. A key another copy
 * of the request recorded meanwhile is a 409; the transaction must not commit.
 */
export async function recorded(
	keyed: KeyedRequest,
	session: Session,
	row: EndpointRow,
	identity: string,
	output: unknown,
	now: number,
): Promise<Response> {
	const text = JSON.stringify({ result: output })
	if (new TextEncoder().encode(text).byteLength > MAX_RECEIPT_BYTES) {
		throw new ServerFault('request_receipt_too_large', `'${row.id}' answered more than ${MAX_RECEIPT_BYTES} bytes, which a receipt does not keep`)
	}
	const written = await keyed.receipts.record(
		session,
		keyed.principal,
		keyed.key,
		{ operation: row.id, identity, output: text },
		now,
		now - RECEIPT_RETENTION_MS,
	)
	if (!written) {
		throw new HttpError(409, 'request_key_concurrent', 'Another copy of this request was answered meanwhile; repeat it to read that answer')
	}
	return jsonResponse({ result: output }, 200)
}
