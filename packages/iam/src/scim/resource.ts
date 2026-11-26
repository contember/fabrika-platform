// The SCIM 2.0 User resource as IAM reads and writes it (RFC 7643 §4.1, RFC 7644 §3.5.2), shaped by what Microsoft
// Entra ID sends: attribute names and PATCH ops in any case, `active` as a boolean or the string "True"/"False", a PATCH
// operation without a path whose value is an object of attributes, and `emails[type eq "work"].value` paths.
//
// IAM stores a subset: the mailbox (`principals.email`), `active` (`principals.disabled_at`), and `userName`,
// `externalId`, `displayName`, `name.givenName`, `name.familyName` (`scim_users`). Every other attribute is accepted
// and ignored, because a provider that receives an error for an attribute it maps fails the whole user.

import { invitedAddress } from '@fabrika/auth-core'
import { z } from 'zod'
import type { ScimUserRecord } from '../repositories/scim'

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
export const LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
export const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'

/** The longest value IAM stores for each SCIM string attribute (the `scim_users` CHECKs). */
export const MAX_ATTRIBUTE_LENGTH = 256

/** A refusal the SCIM surface answers with RFC 7644 §3.12's error body. */
export class ScimError extends Error {
	constructor(
		readonly status: number,
		readonly scimType: string | null,
		detail: string,
	) {
		super(detail)
	}
}

/** One user as IAM keeps it: what a SCIM write produces and what a response is built from. */
export interface ScimUserState {
	readonly userName: string
	/** The mailbox as the provider spelled it; IAM stores it normalized in `principals.email` and this in `label`. */
	readonly email: string
	readonly externalId: string | null
	readonly displayName: string | null
	readonly givenName: string | null
	readonly familyName: string | null
	readonly active: boolean
}

/** `userName` as IAM compares it: SCIM's userName is case-insensitive (RFC 7643 §4.1.1). */
export function userNameKey(userName: string): string {
	return userName.normalize('NFC').trim().toLocaleLowerCase('en-US')
}

/** The state of a user IAM holds. A principal no provider linked yet answers its mailbox spelling as its userName. */
export function stateOf(record: ScimUserRecord): ScimUserState {
	return {
		userName: record.user_name ?? record.label,
		email: record.label,
		externalId: record.external_id,
		displayName: record.display_name,
		givenName: record.given_name,
		familyName: record.family_name,
		active: record.disabled_at === null,
	}
}

/** The User resource for a response. */
export function userResource(record: ScimUserRecord, state: ScimUserState, location: string): Record<string, unknown> {
	const name = state.givenName === null && state.familyName === null
		? {}
		: {
			name: {
				...(state.givenName === null ? {} : { givenName: state.givenName }),
				...(state.familyName === null ? {} : { familyName: state.familyName }),
			},
		}
	return {
		schemas: [USER_SCHEMA],
		id: record.id,
		...(state.externalId === null ? {} : { externalId: state.externalId }),
		userName: state.userName,
		...name,
		...(state.displayName === null ? {} : { displayName: state.displayName }),
		active: state.active,
		emails: [{ value: state.email, type: 'work', primary: true }],
		meta: {
			resourceType: 'User',
			created: isoTime(record.linked_at ?? record.created_at),
			lastModified: isoTime(record.updated_at ?? record.created_at),
			location,
		},
	}
}

function isoTime(seconds: number): string {
	return new Date(seconds * 1000).toISOString()
}

// ── Reading a User body (POST, PUT) ─────────────────────────────────────────

/** `active` as a boolean, or the string Entra sent before its SCIM compliance fix ("True", "False"). */
const activeValue = z.union([z.boolean(), z.string().regex(/^(true|false)$/i).transform((value) => value.toLowerCase() === 'true')])

const stored = z.string().max(MAX_ATTRIBUTE_LENGTH)
const optionalStored = stored.nullish().transform((value) => value === undefined || value === null || value.trim() === '' ? null : value)

const emailEntry = z.object({
	value: z.string(),
	type: z.string().nullish(),
	primary: activeValue.nullish(),
}).passthrough()

/** The User body after `lowerKeys`; anything not named is ignored. */
const userBody = z.object({
	username: stored.min(1),
	externalid: optionalStored,
	displayname: optionalStored,
	active: activeValue.optional(),
	name: z.object({ givenname: optionalStored, familyname: optionalStored }).passthrough().nullish(),
	emails: z.array(emailEntry).nullish(),
}).passthrough()

/**
 * The state a POST or PUT body asks for. `current` is the user a PUT replaces: an absent `active` keeps its value
 * (a new user is active), so a replace never switches a person off or on by leaving the attribute out.
 */
export function parseUserBody(body: unknown, current: ScimUserState | null): ScimUserState {
	const parsed = userBody.safeParse(lowerKeys(body))
	if (!parsed.success) {
		throw new ScimError(400, 'invalidValue', `the user is not valid: ${parsed.error.issues.map((issue) => issue.path.join('.') || 'body').join(', ')}`)
	}
	const user = parsed.data
	return {
		userName: user.username,
		email: mailboxOf(user.emails ?? [], user.username),
		externalId: user.externalid,
		displayName: user.displayname,
		givenName: user.name?.givenname ?? null,
		familyName: user.name?.familyname ?? null,
		active: user.active ?? current?.active ?? true,
	}
}

/** The mailbox among `emails`: the primary one, else the work one, else the first; else `userName` when it is one. */
function mailboxOf(emails: readonly z.infer<typeof emailEntry>[], userName: string): string {
	const chosen = emails.find((entry) => entry.primary === true) ?? emails.find((entry) => entry.type?.toLowerCase() === 'work') ?? emails[0]
	return checkedMailbox(chosen?.value ?? userName)
}

function checkedMailbox(value: string): string {
	const trimmed = value.trim()
	if (invitedAddress(trimmed) === null) {
		throw new ScimError(400, 'invalidValue', 'a user needs an email address, in emails or as its userName')
	}
	return trimmed
}

// ── PATCH (RFC 7644 §3.5.2) ─────────────────────────────────────────────────

const patchBody = z.object({
	operations: z.array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown().optional() }).passthrough()).min(1).max(100),
}).passthrough()

/** Apply a PatchOp body to `current`. An attribute IAM does not store is accepted and ignored. */
export function applyPatch(body: unknown, current: ScimUserState): ScimUserState {
	const parsed = patchBody.safeParse(lowerKeys(body))
	if (!parsed.success) {
		throw new ScimError(400, 'invalidSyntax', 'a PATCH body carries an Operations array')
	}
	let state = current
	for (const operation of parsed.data.operations) {
		const op = operation.op.toLowerCase()
		if (op !== 'add' && op !== 'replace' && op !== 'remove') {
			throw new ScimError(400, 'invalidSyntax', `unknown PATCH op '${operation.op}'`)
		}
		if (operation.path === undefined || operation.path.trim() === '') {
			if (op === 'remove') throw new ScimError(400, 'noTarget', 'a remove operation names its path')
			if (!isPlainObject(operation.value)) throw new ScimError(400, 'invalidValue', 'an operation without a path carries an object of attributes')
			for (const [path, value] of flatten(operation.value)) {
				state = applyAttribute(state, path, value)
			}
			continue
		}
		state = op === 'remove' ? removeAttribute(state, operation.path) : applyAttribute(state, operation.path, operation.value)
	}
	return state
}

/** The path without the core schema's URN prefix, lower-cased (attribute names are case-insensitive, RFC 7643 §2.1). */
function normalizedPath(path: string): string {
	const lowered = path.trim().toLowerCase()
	const prefix = `${USER_SCHEMA.toLowerCase()}:`
	return lowered.startsWith(prefix) ? lowered.slice(prefix.length) : lowered
}

/** `emails`, `emails[type eq "work"]`, `emails[primary eq true]` and their `.value`. */
const EMAIL_PATH = /^emails(\[\s*(type\s+eq\s+"work"|primary\s+eq\s+true)\s*\])?(\.value)?$/

function applyAttribute(state: ScimUserState, path: string, raw: unknown): ScimUserState {
	const value = unwrapped(raw)
	const key = normalizedPath(path)
	switch (key) {
		case 'username':
			return { ...state, userName: requiredString(value, 'userName') }
		case 'externalid':
			return { ...state, externalId: optionalString(value, 'externalId') }
		case 'displayname':
			return { ...state, displayName: optionalString(value, 'displayName') }
		case 'name.givenname':
			return { ...state, givenName: optionalString(value, 'name.givenName') }
		case 'name.familyname':
			return { ...state, familyName: optionalString(value, 'name.familyName') }
		case 'name': {
			if (!isPlainObject(value)) throw new ScimError(400, 'invalidValue', 'name is an object')
			const name = lowerKeys(value)
			return {
				...state,
				...(isPlainObject(name) && 'givenname' in name ? { givenName: optionalString(name['givenname'], 'name.givenName') } : {}),
				...(isPlainObject(name) && 'familyname' in name ? { familyName: optionalString(name['familyname'], 'name.familyName') } : {}),
			}
		}
		case 'active':
			return { ...state, active: activeOf(value) }
	}
	const email = EMAIL_PATH.exec(key)
	if (email !== null) {
		// `emails` with no filter and no `.value` carries the whole multi-valued attribute.
		if (email[1] === undefined && email[3] === undefined) {
			const entries = z.array(emailEntry).safeParse(Array.isArray(raw) ? raw : [raw])
			if (!entries.success) throw new ScimError(400, 'invalidValue', 'emails is an array of {value, type, primary}')
			return entries.data.length === 0 ? state : { ...state, email: mailboxOf(entries.data, '') }
		}
		const address = isPlainObject(value) && typeof value['value'] === 'string' ? value['value'] : value
		return { ...state, email: checkedMailbox(requiredString(address, 'emails')) }
	}
	return state
}

function removeAttribute(state: ScimUserState, path: string): ScimUserState {
	switch (normalizedPath(path)) {
		case 'username':
			throw new ScimError(400, 'mutability', 'userName is required')
		case 'externalid':
			return { ...state, externalId: null }
		case 'displayname':
			return { ...state, displayName: null }
		case 'name.givenname':
			return { ...state, givenName: null }
		case 'name.familyname':
			return { ...state, familyName: null }
		case 'name':
			return { ...state, givenName: null, familyName: null }
		case 'active':
			throw new ScimError(400, 'mutability', 'active is set, not removed')
	}
	// The mailbox is what identifies the person to IAM: removing an email keeps it.
	return state
}

/** Entra wraps some single values in a one-entry array of `{ value }`. */
function unwrapped(value: unknown): unknown {
	if (Array.isArray(value) && value.length === 1) {
		const [only] = value
		if (isPlainObject(only) && Object.keys(only).length === 1 && 'value' in only) return only['value']
	}
	return value
}

function activeOf(value: unknown): boolean {
	const parsed = activeValue.safeParse(value)
	if (!parsed.success) throw new ScimError(400, 'invalidValue', 'active is a boolean')
	return parsed.data
}

function requiredString(value: unknown, attribute: string): string {
	if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ATTRIBUTE_LENGTH) {
		throw new ScimError(400, 'invalidValue', `${attribute} is a string of 1 to ${MAX_ATTRIBUTE_LENGTH} characters`)
	}
	return value
}

function optionalString(value: unknown, attribute: string): string | null {
	if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null
	return requiredString(value, attribute)
}

/** An object of attributes as `[path, value]` pairs: `{ name: { givenName } }` and `{ "name.givenName" }` alike. */
function flatten(value: Record<string, unknown>, prefix = ''): [string, unknown][] {
	return Object.entries(value).flatMap(([key, entry]): [string, unknown][] => {
		const path = `${prefix}${key}`
		return isPlainObject(entry) && normalizedPath(path) === 'name' ? flatten(entry, `${path}.`) : [[path, entry]]
	})
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every object key lower-cased, recursively: SCIM attribute names are case-insensitive. Values are untouched. */
export function lowerKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(lowerKeys)
	if (!isPlainObject(value)) return value
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.toLowerCase(), lowerKeys(entry)]))
}
