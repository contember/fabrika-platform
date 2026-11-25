// The subscription row of Web Push (ADR-0088 §7, §10): `POST /__fabrika/push/subscription`, served by the framework
// under the row's own access. The page (or the service worker) asks whose a browser's subscription is, records or
// replaces it, or removes it, always as the caller: the principal comes from the verified token, never from the body.
// A terminal records nothing (403), an endpoint outside the push services' fixed origins is refused before anything is
// stored, and a subscription made with another VAPID key than the environment's current one is refused, so the sender
// only ever signs to a push service, with a key the row was made for. Nothing here sends a push.

import { egressAdmits, type EgressEntry, parseEgressEntry } from '@fabrika/auth-core'
import type { PushBinding, PushSubscriptionKeys } from '@fabrika/db/framework'
import { z } from 'zod/v4'
import { PUSH_SERVICE_ORIGINS } from '../contract/defaults'
import { HttpError } from '../errors'

/** The longest endpoint the row stores; the push services' own are a few hundred characters. */
export const PUSH_ENDPOINT_MAX_LENGTH = 1_024

/** What the row answers to every operation: whose the endpoint is now, for the caller. */
export interface PushSubscriptionAnswer {
	readonly status: PushBinding
	readonly endpoint: string
}

/** One request of the row, parsed and checked. */
export type PushSubscriptionRequest =
	| { readonly op: 'status'; readonly endpoint: string }
	| { readonly op: 'remove'; readonly endpoint: string }
	| { readonly op: 'record'; readonly subscription: PushSubscriptionKeys; readonly replace: string | null }

/** Unpadded base64url of `bytes` bytes: what `PushSubscription.toJSON()` and a VAPID public key are written as. */
function base64Url(bytes: number, leading?: string) {
	const length = Math.ceil((bytes * 4) / 3)
	const pattern = new RegExp(`^${leading ?? ''}[A-Za-z0-9_-]{${length - (leading === undefined ? 0 : 1)}}$`)
	return z.string().transform((value) => value.replace(/=+$/, '')).refine((value) => pattern.test(value), `is not ${bytes} bytes of base64url`)
}

// An uncompressed P-256 point is 65 bytes starting with 0x04, whose first base64url character is 'B'.
const p256Point = base64Url(65, 'B')
const endpointText = z.string().min(1).max(PUSH_ENDPOINT_MAX_LENGTH)

const requestSchema = z.discriminatedUnion('op', [
	z.strictObject({ op: z.literal('status'), endpoint: endpointText }),
	z.strictObject({ op: z.literal('remove'), endpoint: endpointText }),
	z.strictObject({
		op: z.literal('record'),
		subscription: z.strictObject({
			endpoint: endpointText,
			expirationTime: z.number().nullable().optional(),
			keys: z.strictObject({ p256dh: p256Point, auth: base64Url(16) }),
		}),
		/** The VAPID public key the browser subscribed with (`subscription.options.applicationServerKey`). */
		key: p256Point,
		/** The endpoint this subscription replaces: the old key's, or the one a `pushsubscriptionchange` dropped. */
		replace: endpointText.optional(),
	}),
])

const SERVICES: readonly EgressEntry[] = PUSH_SERVICE_ORIGINS.map((origin) => {
	const parsed = parseEgressEntry(origin)
	if (!parsed.ok) {
		throw new TypeError(`push service origin ${origin} is no egress entry`)
	}
	return parsed.entry
})

/** Whether `endpoint` is a URL of one of the push services, written as the URL parser writes it, without credentials. */
export function isPushServiceEndpoint(endpoint: string): boolean {
	let url: URL
	try {
		url = new URL(endpoint)
	} catch {
		return false
	}
	return url.href === endpoint && url.username === '' && url.password === '' && url.hash === '' && egressAdmits(SERVICES, url)
}

/**
 * The request a body holds, checked: its JSON against the strict schema (400 `push_subscription`), and a record's
 * endpoint against the push services (400 `push_service`) and its key against `currentKey` (409 `push_key`: the page
 * subscribes again with the key its config names). A status or a removal names any endpoint: it only reads or deletes
 * the caller's own row.
 */
export function pushSubscriptionRequest(body: Uint8Array, currentKey: () => string): PushSubscriptionRequest {
	let json: unknown
	try {
		json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
	} catch {
		throw new HttpError(400, 'push_subscription', 'The body is no JSON')
	}
	const parsed = requestSchema.safeParse(json)
	if (!parsed.success) {
		throw new HttpError(
			400,
			'push_subscription',
			`The body is no subscription request: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
		)
	}
	const request = parsed.data
	if (request.op !== 'record') {
		return request
	}
	const { subscription } = request
	if (!isPushServiceEndpoint(subscription.endpoint)) {
		throw new HttpError(400, 'push_service', 'The subscription names no push service this application sends to')
	}
	if (request.key !== currentKey()) {
		throw new HttpError(409, 'push_key', "The subscription was made with another key than the application's current one; subscribe again")
	}
	return {
		op: 'record',
		subscription: { endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, vapidKey: request.key },
		replace: request.replace ?? null,
	}
}

/** Whether `key` is a VAPID public key as the environment must hand it: an unpadded base64url P-256 point. */
export function isVapidPublicKey(key: string): boolean {
	return p256Point.safeParse(key).data === key
}
