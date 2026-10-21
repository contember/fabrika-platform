/**
 * The known-device cookie (OWASP "device cookies"): a browser that completed a password login for a
 * principal carries a signed proof of it, and a later login FOR THAT PRINCIPAL from that browser is
 * throttled by its own per-device bucket instead of the account and deployment-wide ones. Those two
 * buckets are keyed on values an attacker can pick (an address, nothing at all), so without this one
 * client could lock out a known account, or every password user, including the owners.
 */
import { z } from 'zod'
import { randomToken } from '../oidc'
import { getSigner, verifyInternal } from '../signing'
import { readCookie, serializeCookie } from './cookies'
import type { AuthEnv } from './oidc-flight'

export const KNOWN_DEVICE_COOKIE = '__Host-px_device'

/** Three session lifetimes: a regular user keeps the exemption across renewals, a lost browser drops out within a quarter. */
export const KNOWN_DEVICE_TTL_SECONDS = 90 * 24 * 60 * 60

/** Audience of the device token — never an app id, so it can never pass as an access token or an OIDC flight. */
const KNOWN_DEVICE_AUDIENCE = 'fabrika:iam:known-device'

export interface KnownDevice {
	principalId: string
	deviceId: string
}

const knownDeviceSchema = z.object({ sub: z.string().min(1), dev: z.string().min(1) })

/** A `Set-Cookie` naming a fresh device id for `principalId`. */
export async function knownDeviceCookie(env: AuthEnv, principalId: string): Promise<string> {
	const signer = await getSigner(env)
	const token = await signer.signInternal({ sub: principalId, dev: randomToken(16) }, KNOWN_DEVICE_AUDIENCE, KNOWN_DEVICE_TTL_SECONDS)
	return serializeCookie(KNOWN_DEVICE_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: KNOWN_DEVICE_TTL_SECONDS, path: '/' })
}

/** The device the request's cookie proves, or null when it is absent, forged, expired or malformed. */
export async function readKnownDevice(env: AuthEnv, request: Request): Promise<KnownDevice | null> {
	const raw = readCookie(request.headers.get('cookie'), KNOWN_DEVICE_COOKIE)
	if (raw === null || raw === '') return null
	const payload = await verifyInternal(await getSigner(env), raw, KNOWN_DEVICE_AUDIENCE)
	const parsed = knownDeviceSchema.safeParse(payload)
	return parsed.success ? { principalId: parsed.data.sub, deviceId: parsed.data.dev } : null
}
