// A webhook delivery's signature, checked over the raw body before anything parses it. Each verifier is framework
// code: a preset reads its provider's headers, an `hmac` shape computes the declared HMAC, `basic` and `bearer` compare
// the secret itself. Every comparison is constant-time.

import { FORM_URLENCODED_TYPE, type HmacAlgorithm, type HmacScheme, type WebhookScheme } from '@fabrika/auth-core'

/** How far a signed timestamp may be from now: the window in which a captured delivery could be replayed. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000

/** The prefix of a Standard Webhooks secret, whose rest is the key in base64. */
const STANDARD_SECRET_PREFIX = 'whsec_'

const ALGORITHMS: Readonly<Record<HmacAlgorithm, string>> = { sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' }

const encoder = new TextEncoder()

/** What a verifier reads of a delivery. */
export interface SignedDelivery {
	readonly headers: Headers
	readonly body: Uint8Array<ArrayBuffer>
	/**
	 * The URL the provider posted to: `FABRIKA_APP_ORIGIN` and the request's path and query, which Twilio signs. `null`
	 * where the environment has no public origin.
	 */
	readonly url: string | null
}

/** Whether the delivery proves it holds `secret` under `scheme`. `now` is the clock a signed timestamp is checked against. */
export async function verifyDelivery(scheme: WebhookScheme, delivery: SignedDelivery, secret: string, now: number): Promise<boolean> {
	const { headers, body } = delivery
	switch (scheme) {
		case 'github-sha256':
			return await verifyHmac(GITHUB, headers, encoder.encode(secret), body, now)
		case 'slack':
			return await verifySlack(headers, encoder.encode(secret), body, now)
		case 'stripe':
			return await verifyStripe(headers.get('Stripe-Signature'), encoder.encode(secret), body, now)
		case 'standard-webhooks':
			return await verifyStandard(headers, standardKey(secret), body, now)
		case 'twilio':
			return await verifyTwilio(delivery, encoder.encode(secret))
	}
	if ('hmac' in scheme) {
		return await verifyHmac(scheme.hmac, headers, encoder.encode(secret), body, now)
	}
	const authorization = headers.get('Authorization')
	if ('basic' in scheme) {
		return await sameText(basicPassword(authorization), secret)
	}
	return await sameText(bearerToken(authorization), secret)
}

/** GitHub's `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the body. */
const GITHUB: HmacScheme = { header: 'X-Hub-Signature-256', algorithm: 'sha256', encoding: 'hex', prefix: 'sha256=', signed: 'body' }

async function verifyHmac(
	scheme: HmacScheme,
	headers: Headers,
	key: Uint8Array<ArrayBuffer>,
	body: Uint8Array<ArrayBuffer>,
	now: number,
): Promise<boolean> {
	const header = headers.get(scheme.header)
	const prefix = scheme.prefix ?? ''
	if (header === null || !header.startsWith(prefix)) {
		return false
	}
	const signature = decode(header.slice(prefix.length), scheme.encoding)
	if (signature === null) {
		return false
	}
	const parts: string[] = []
	if (scheme.id !== undefined) {
		const id = headers.get(scheme.id)
		if (id === null || id === '') {
			return false
		}
		parts.push(id)
	}
	if (scheme.signed === 'timestamp.body') {
		const timestamp = scheme.timestamp === undefined ? null : headers.get(scheme.timestamp)
		if (timestamp === null || !fresh(timestamp, now)) {
			return false
		}
		parts.push(timestamp)
	}
	return await hmacVerifies(scheme.algorithm, key, [signature], signedContent(parts, body))
}

/** Stripe's `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=<hex>…]` over `<t>.<body>`; a rotated secret sends two `v1`. */
async function verifyStripe(header: string | null, key: Uint8Array<ArrayBuffer>, body: Uint8Array<ArrayBuffer>, now: number): Promise<boolean> {
	if (header === null) {
		return false
	}
	let timestamp: string | null = null
	const signatures: Uint8Array<ArrayBuffer>[] = []
	for (const item of header.split(',')) {
		const separator = item.indexOf('=')
		const name = item.slice(0, separator).trim()
		const value = item.slice(separator + 1).trim()
		if (separator > 0 && name === 't') {
			timestamp = value
		} else if (separator > 0 && name === 'v1') {
			const signature = decode(value, 'hex')
			if (signature !== null) {
				signatures.push(signature)
			}
		}
	}
	if (timestamp === null || !fresh(timestamp, now)) {
		return false
	}
	return await hmacVerifies('sha256', key, signatures, signedContent([timestamp], body))
}

/** Slack's `X-Slack-Signature: v0=<hex>`, an HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<body>`, within five minutes. */
async function verifySlack(headers: Headers, key: Uint8Array<ArrayBuffer>, body: Uint8Array<ArrayBuffer>, now: number): Promise<boolean> {
	const timestamp = headers.get('X-Slack-Request-Timestamp')
	const header = headers.get('X-Slack-Signature')
	if (timestamp === null || header === null || !header.startsWith('v0=') || !fresh(timestamp, now)) {
		return false
	}
	const signature = decode(header.slice(3), 'hex')
	return signature !== null && (await hmacVerifies('sha256', key, [signature], prefixed(`v0:${timestamp}:`, body)))
}

/**
 * Twilio's `X-Twilio-Signature`: the base64 HMAC-SHA1 of the URL it posted to, followed by a form's parameters sorted by
 * name, each name then its value. A JSON body is signed through the URL instead: its `bodySHA256` parameter must be
 * the body's SHA-256. Twilio signs no timestamp.
 */
async function verifyTwilio(delivery: SignedDelivery, key: Uint8Array<ArrayBuffer>): Promise<boolean> {
	const header = delivery.headers.get('X-Twilio-Signature')
	const signature = header === null ? null : decode(header, 'base64')
	const content = await twilioSigned(delivery)
	return signature !== null && content !== null && (await hmacVerifies('sha1', key, [signature], encoder.encode(content)))
}

async function twilioSigned({ headers, body, url }: SignedDelivery): Promise<string | null> {
	if (url === null) {
		return null
	}
	if (headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() === FORM_URLENCODED_TYPE) {
		const text = utf8(body)
		if (text === null) {
			return null
		}
		const parameters = [...new URLSearchParams(text)].sort(([leftName, leftValue], [rightName, rightValue]) =>
			compareText(leftName, rightName) || compareText(leftValue, rightValue)
		)
		return url + parameters.map(([name, value]) => name + value).join('')
	}
	const claimed = new URL(url).searchParams.get('bodySHA256')
	const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), (byte) => byte.toString(16).padStart(2, '0')).join('')
	return claimed?.toLowerCase() === digest ? url : null
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

/** Standard Webhooks: `webhook-signature: v1,<base64> …` over `<webhook-id>.<webhook-timestamp>.<body>`. */
async function verifyStandard(headers: Headers, key: Uint8Array<ArrayBuffer> | null, body: Uint8Array<ArrayBuffer>, now: number): Promise<boolean> {
	const id = headers.get('webhook-id')
	const timestamp = headers.get('webhook-timestamp')
	const header = headers.get('webhook-signature')
	if (key === null || id === null || id === '' || timestamp === null || header === null || !fresh(timestamp, now)) {
		return false
	}
	const signatures = header.split(' ').flatMap((entry) => {
		const signature = entry.startsWith('v1,') ? decode(entry.slice(3), 'base64') : null
		return signature === null ? [] : [signature]
	})
	return await hmacVerifies('sha256', key, signatures, signedContent([id, timestamp], body))
}

/** A Standard Webhooks secret is `whsec_` and the key in base64; `null` when it is not. */
export function standardKey(secret: string): Uint8Array<ArrayBuffer> | null {
	return secret.startsWith(STANDARD_SECRET_PREFIX) ? decode(secret.slice(STANDARD_SECRET_PREFIX.length), 'base64') : null
}

/** A timestamp in Unix seconds within the tolerance of `now`. */
function fresh(timestamp: string, now: number): boolean {
	if (!/^[0-9]{1,12}$/.test(timestamp)) {
		return false
	}
	return Math.abs(now - Number(timestamp) * 1000) <= WEBHOOK_TIMESTAMP_TOLERANCE_MS
}

/** `<part>.<part>.<body>`: what a timestamped or identified signature covers. */
function signedContent(parts: readonly string[], body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
	return parts.length === 0 ? body : prefixed(`${parts.join('.')}.`, body)
}

function prefixed(head: string, body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
	const bytes = encoder.encode(head)
	const content = new Uint8Array(bytes.byteLength + body.byteLength)
	content.set(bytes, 0)
	content.set(body, bytes.byteLength)
	return content
}

/** Whether one of `signatures` is the HMAC of `content`; `crypto.subtle.verify` compares in constant time. */
async function hmacVerifies(
	algorithm: HmacAlgorithm,
	key: Uint8Array<ArrayBuffer>,
	signatures: readonly Uint8Array<ArrayBuffer>[],
	content: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
	if (signatures.length === 0 || key.byteLength === 0) {
		return false
	}
	const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: ALGORITHMS[algorithm] }, false, ['verify'])
	let verified = false
	for (const signature of signatures) {
		verified = (await crypto.subtle.verify('HMAC', imported, signature, content)) || verified
	}
	return verified
}

/** The password of `Authorization: Basic <base64(user:password)>`; the user name is not checked. */
function basicPassword(authorization: string | null): string | null {
	const match = authorization === null ? null : /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)
	const credentials = match?.[1] === undefined ? null : decode(match[1], 'base64')
	const text = credentials === null ? null : utf8(credentials)
	const separator = text?.indexOf(':') ?? -1
	return text === null || separator < 0 ? null : text.slice(separator + 1)
}

function utf8(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		return null
	}
}

function bearerToken(authorization: string | null): string | null {
	const match = authorization === null ? null : /^Bearer (\S+)$/i.exec(authorization)
	return match?.[1] ?? null
}

/** Whether two texts are equal, compared as SHA-256 digests in constant time. */
async function sameText(given: string | null, expected: string): Promise<boolean> {
	if (given === null || expected === '') {
		return false
	}
	const [left, right] = await Promise.all(
		[given, expected].map(async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))),
	)
	if (left === undefined || right === undefined) {
		return false
	}
	let difference = 0
	for (let index = 0; index < left.byteLength; index++) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
	}
	return difference === 0
}

/** Bytes of a hex or base64 text; `null` when it is not one. */
function decode(text: string, encoding: 'hex' | 'base64'): Uint8Array<ArrayBuffer> | null {
	if (encoding === 'hex') {
		if (!/^(?:[0-9a-fA-F]{2})+$/.test(text)) {
			return null
		}
		const bytes = new Uint8Array(text.length / 2)
		for (let index = 0; index < bytes.byteLength; index++) {
			bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
		}
		return bytes
	}
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) || text === '') {
		return null
	}
	const binary = atob(text)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

/** The GitHub account a payload names, as a binding records it: `installation:<id>` or `repository:<id>`. */
export function githubAccounts(payload: unknown): readonly string[] {
	const accounts: string[] = []
	for (const kind of ['installation', 'repository'] as const) {
		const holder = ownField(payload, kind)
		const id = ownField(holder, 'id')
		if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
			accounts.push(`${kind}:${id}`)
		}
	}
	return accounts
}

function ownField(value: unknown, name: string): unknown {
	return typeof value === 'object' && value !== null && Object.hasOwn(value, name) ? Reflect.get(value, name) : undefined
}
