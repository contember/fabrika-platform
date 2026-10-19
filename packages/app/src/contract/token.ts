// Signed tokens: a purpose declared once in `defineApp`'s options (`token(Claims, { maxDays })`), a field of a
// procedure's input or `http.query` that carries one (`signedToken('<purpose>')`), and `ctx.tokens.sign` of a site that
// declares `signs`. On the wire a token is a string; the framework verifies it as it parses the input and hands the
// handler the purpose's typed claims. A token is single-purpose and no credential: it opens no mount.

import { z } from 'zod/v4'
import type { InputSchema, NotLoose, Schema } from './define'

const SIGNED_TOKEN = Symbol('fabrika.signedToken')

/** The longest token a field admits: a purpose's claims, a key id, an expiry and a signature, URL-safe. */
export const SIGNED_TOKEN_MAX_LENGTH = 4096

/** The most days any purpose may declare: a key stays verifying that long after it stopped signing. */
export const TOKEN_MAX_DAYS = 3650

/** One token purpose: the claims a token of it carries and the longest lifetime a site may sign one for. */
export interface TokenPurpose<C extends Schema = Schema> {
	readonly '~kind': 'token'
	readonly claims: C
	readonly maxDays: number
}

export type TokenPurposes = { readonly [purpose: string]: TokenPurpose }

export interface TokenOptions {
	/** The longest lifetime, in days, of a token of this purpose. */
	readonly maxDays: number
}

/**
 * A token purpose: `token(Recipient, { maxDays: 400 })` under `defineApp(vocabulary, tables, { tokens })`. `Claims` is a
 * strict object; `compileContract` and the checker refuse what a token may not carry.
 */
export function token<C extends InputSchema>(claims: C & NotLoose<C>, options: TokenOptions): TokenPurpose<C> {
	return Object.freeze({ '~kind': 'token', claims, maxDays: options.maxDays })
}

/** What `signedToken()` adds to its schema: the purpose a token of the field must be signed for. */
export interface SignedTokenMark {
	readonly purpose: string
}

type TokenBrand<P extends string> = `fabrika.token:${P}`

/** A field that carries a signed token of purpose `P`: a string on the wire, the purpose's claims in the handler. */
export type SignedTokenSchema<P extends string> =
	& (PropertyKey extends TokenBrand<P> ? z.ZodString : z.core.$ZodBranded<z.ZodString, TokenBrand<P>>)
	& { readonly [SIGNED_TOKEN]: SignedTokenMark }

/** The marks `signedToken` made: a property another module set on a schema is no token field. */
const marks = new WeakSet<object>()

/**
 * A field of a procedure's input or `http.query` that carries a token of `purpose`, verified as the input is parsed:
 * `z.strictObject({ t: signedToken('unsubscribe') })`. Only a top-level field; the handler receives the claims.
 */
export function signedToken<const P extends string>(purpose: P): SignedTokenSchema<P> {
	const mark: SignedTokenMark = Object.freeze({ purpose })
	marks.add(mark)
	return Object.assign(z.string().min(1).max(SIGNED_TOKEN_MAX_LENGTH).brand<TokenBrand<P>>(), { [SIGNED_TOKEN]: mark })
}

/** The mark of a `signedToken()` schema, or `null` for any other schema. */
export function signedTokenOf(schema: Schema): SignedTokenMark | null {
	const mark: unknown = Reflect.get(schema, SIGNED_TOKEN)
	return isMark(mark) ? mark : null
}

function isMark(value: unknown): value is SignedTokenMark {
	return typeof value === 'object' && value !== null && marks.has(value)
}

/** The purpose a field's parsed value names when the field is a signed token; `never` for any other field. */
export type TokenPurposeOf<V> = V extends { readonly [z.core.$brand]: infer B } ? keyof B extends TokenBrand<infer P> ? P : never : never

/** One field as the handler holds it: a signed token as the claims of its purpose, any other field as it is. */
type ClaimsField<V, T> = [TokenPurposeOf<NonNullable<V>>] extends [never] ? V
	:
		| (TokenPurposeOf<NonNullable<V>> extends keyof T ? T[TokenPurposeOf<NonNullable<V>>] extends TokenPurpose<infer C> ? z.output<C> : never : never)
		| (undefined extends V ? undefined : never)

/** An input as its handler receives it: each signed token field replaced by the verified claims of its purpose. */
export type WithClaims<In, T> = [keyof In] extends [never] ? In : { readonly [F in keyof In]: ClaimsField<In[F], T> }

/** `ctx.tokens` of a site that declares `signs`: a token of one of those purposes, valid for `days`. */
export interface TokenSigning<T extends TokenPurposes, S extends string> {
	sign<const P extends S & keyof T & string>(purpose: P, claims: z.input<T[P]['claims']>, options: { readonly days: number }): string
}
