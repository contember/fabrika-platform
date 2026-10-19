// Signed tokens at runtime: the keys `FABRIKA_TOKEN_KEYS` hands the environment, `ctx.tokens.sign` of a site that
// declares `signs`, and the verification of each token field of a procedure's input and `http.query` as they are parsed.
// A token is `<key id>.<payload>.<signature>`: the payload is the purpose, the expiry and the claims as base64url JSON,
// and the signature an HMAC-SHA256 over the key id and the payload, so a token of one purpose never passes as another.

import { type ContractArtifact, FABRIKA_TOKEN_KEYS, type SchemaShape } from '@fabrika/auth-core'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod/v4'
import type { Schema } from '../contract/define'
import { BadRequestError } from '../errors'
import { CapabilityRefusedError } from './capability'
import { ServerFault } from './faults'

const DAY_SECONDS = 86_400
const KEY_ID = /^[A-Za-z0-9_-]{8,64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
/** A key below this many bytes is refused at boot: an HMAC key shorter than its hash is guessable sooner. */
const MIN_SECRET_BYTES = 32

/** One key of the environment: its id, which each token it signs carries, and its secret. */
export interface TokenKey {
	readonly id: string
	readonly secret: Uint8Array
}

/** A purpose as the runtime holds it: the claims schema the application declared, and the longest lifetime. */
export interface RuntimePurpose {
	readonly claims: Schema
	readonly maxDays: number
}

/**
 * The keys of `FABRIKA_TOKEN_KEYS`: `<kid>:<secret>` entries joined by `,`, the signing key first. Required when the
 * contract declares a token purpose; refused at boot when malformed. `null` without purposes or after a problem.
 */
export function readTokenKeys(
	framework: Readonly<Record<string, string>>,
	artifact: ContractArtifact,
	problems: string[],
): readonly TokenKey[] | null {
	const value = framework[FABRIKA_TOKEN_KEYS]?.trim() ?? ''
	if (artifact.tokens === undefined || Object.keys(artifact.tokens).length === 0) {
		return null
	}
	if (value === '') {
		problems.push(`${FABRIKA_TOKEN_KEYS} is not set; the contract declares token purposes, and the deploy writes their keys`)
		return null
	}
	const keys: TokenKey[] = []
	for (const entry of value.split(',')) {
		const separator = entry.indexOf(':')
		const id = entry.slice(0, separator)
		const encoded = entry.slice(separator + 1)
		const secret = separator < 0 || !BASE64URL.test(encoded) ? null : new Uint8Array(Buffer.from(encoded, 'base64url'))
		if (!KEY_ID.test(id) || secret === null || secret.byteLength < MIN_SECRET_BYTES || keys.some((key) => key.id === id)) {
			problems.push(`${FABRIKA_TOKEN_KEYS} is not a list of <key id>:<secret> entries, each id once and each secret at least ${MIN_SECRET_BYTES} bytes`)
			return null
		}
		keys.push({ id, secret })
	}
	return keys
}

/** The claims a verified token carried, and every text in them: a redirect target or a row id the request may use. */
export interface VerifiedTokens {
	readonly carried: ReadonlySet<string>
}

export const NO_VERIFIED_TOKENS: VerifiedTokens = Object.freeze({ carried: new Set<string>() })

/**
 * The environment's signed tokens. `purposes` are the application's declared claims schemas, by purpose; `keys` are
 * `null` when the contract declares none, so a sign or a verification refuses.
 */
export class SignedTokens {
	readonly #purposes: ReadonlyMap<string, RuntimePurpose>
	readonly #keys: readonly TokenKey[]
	readonly #now: () => number

	constructor(purposes: ReadonlyMap<string, RuntimePurpose>, keys: readonly TokenKey[] | null, now: () => number = Date.now) {
		this.#purposes = purposes
		this.#keys = keys ?? []
		this.#now = now
	}

	/**
	 * `ctx.tokens` of a site: signs a token of a purpose `signs` names, valid for `days` (at most the purpose's
	 * `maxDays`). The claims are parsed by the purpose's schema first, so a token never carries what a verifier refuses.
	 */
	context(site: string, signs: readonly string[]): { readonly sign: (purpose: string, claims: unknown, options: unknown) => string } {
		return Object.freeze({
			sign: (purpose: string, claims: unknown, options: unknown): string => this.#sign(site, signs, purpose, claims, options),
		})
	}

	#sign(site: string, signs: readonly string[], purpose: string, claims: unknown, options: unknown): string {
		const declared = signs.includes(purpose) ? this.#purposes.get(purpose) : undefined
		if (declared === undefined) {
			throw new CapabilityRefusedError('undeclared_signs', `${site} does not declare signs: ['${String(purpose)}']`)
		}
		const days: unknown = typeof options === 'object' && options !== null ? Reflect.get(options, 'days') : undefined
		if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days > declared.maxDays) {
			throw new CapabilityRefusedError(
				'undeclared_signs',
				`${site} signed a '${purpose}' token for ${String(days)} days; the purpose allows 1 to ${declared.maxDays}`,
			)
		}
		const parsed = z.safeParse(declared.claims, claims)
		if (!parsed.success) {
			throw new ServerFault('token_claims_refused', `${site} signed a '${purpose}' token whose claims its schema refuses`)
		}
		const [key] = this.#keys
		if (key === undefined) {
			throw new ServerFault('token_keys_missing', `${site} signed a '${purpose}' token, and the environment holds no token key`)
		}
		const expiresAt = Math.floor(this.#now() / 1000) + days * DAY_SECONDS
		const payload = Buffer.from(JSON.stringify({ p: purpose, x: expiresAt, c: parsed.data })).toString('base64url')
		return `${key.id}.${payload}.${signature(key, payload)}`
	}

	/**
	 * The claims of `token` when it is a token of `purpose` this environment signed and it has not expired; a 400
	 * otherwise, which says only that it is not valid, so a caller learns nothing about the keys.
	 */
	verify(purpose: string, token: string): Readonly<Record<string, unknown>> {
		const [id = '', payload = '', given = '', ...rest] = token.split('.')
		const key = this.#keys.find((candidate) => candidate.id === id)
		const declared = this.#purposes.get(purpose)
		if (rest.length > 0 || key === undefined || declared === undefined || !BASE64URL.test(payload) || !BASE64URL.test(given)) {
			throw invalid()
		}
		const expected = Buffer.from(signature(key, payload), 'base64url')
		const presented = Buffer.from(given, 'base64url')
		if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
			throw invalid()
		}
		const body = parsePayload(payload)
		if (body === null || body.p !== purpose) {
			throw invalid()
		}
		if (body.x <= Math.floor(this.#now() / 1000)) {
			throw new BadRequestError('The signed token has expired')
		}
		const claims = z.safeParse(declared.claims, body.c)
		if (!claims.success || !isRecord(claims.data)) {
			throw invalid()
		}
		return Object.freeze(claims.data)
	}

	/**
	 * Each top-level signed token field of `value` (by `shape`, the approved input or query) replaced by its verified
	 * claims, and every text those claims carry.
	 */
	verifyFields(shape: SchemaShape | null, value: Readonly<Record<string, unknown>>, into: Set<string>): Readonly<Record<string, unknown>> {
		const fields = tokenFields(shape)
		if (fields.size === 0) {
			return value
		}
		const verified: Record<string, unknown> = { ...value }
		for (const [field, purpose] of fields) {
			const text = value[field]
			if (typeof text === 'string') {
				const claims = this.verify(purpose, text)
				collectTexts(claims, into)
				verified[field] = claims
			}
		}
		return Object.freeze(verified)
	}
}

/** The top-level fields of an object shape that carry a signed token, optional or not, with their purposes. */
export function tokenFields(shape: SchemaShape | null): ReadonlyMap<string, string> {
	const fields = new Map<string, string>()
	if (shape?.type !== 'object') {
		return fields
	}
	for (const [name, field] of Object.entries(shape.fields)) {
		const inner = field.type === 'optional' ? field.inner : field
		if (inner.type === 'token') {
			fields.set(name, inner.purpose)
		}
	}
	return fields
}

function signature(key: TokenKey, payload: string): string {
	return createHmac('sha256', key.secret).update(`${key.id}.${payload}`).digest('base64url')
}

function invalid(): BadRequestError {
	return new BadRequestError('The signed token is not valid')
}

const payloadSchema = z.strictObject({ p: z.string(), x: z.int(), c: z.unknown() })

function parsePayload(payload: string): z.output<typeof payloadSchema> | null {
	try {
		const parsed = z.safeParse(payloadSchema, JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

function collectTexts(value: unknown, into: Set<string>): void {
	if (typeof value === 'string') {
		into.add(value)
	} else if (Array.isArray(value)) {
		for (const item of value) collectTexts(item, into)
	} else if (isRecord(value)) {
		for (const item of Object.values(value)) collectTexts(item, into)
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
