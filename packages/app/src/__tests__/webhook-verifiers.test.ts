// Every webhook verifier over the raw body: a preset reads its provider's headers, an `hmac` shape computes what it
// declares, `basic` and `bearer` compare the binding's secret. A signature of another secret or body, a stale signed
// timestamp and a missing header are refused alike.

import type { WebhookScheme } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { verifyDelivery, WEBHOOK_TIMESTAMP_TOLERANCE_MS } from '../implement/verifiers'

const NOW = Date.UTC(2026, 9, 19, 12)
const SECONDS = String(Math.floor(NOW / 1000))
const SECRET = 'a'.repeat(64)
const raw = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' })
const body = new TextEncoder().encode(raw)

const hmac = (algorithm: string, key: string | Buffer, content: string, encoding: 'hex' | 'base64') =>
	createHmac(algorithm, key).update(content).digest(encoding)

const verify = (scheme: WebhookScheme, headers: Record<string, string>, secret = SECRET, now = NOW) =>
	verifyDelivery(scheme, new Headers(headers), secret, body, now)

describe('presets', () => {
	test("github-sha256: GitHub's X-Hub-Signature-256 over the body", async () => {
		const signature = `sha256=${hmac('sha256', SECRET, raw, 'hex')}`
		expect(await verify('github-sha256', { 'X-Hub-Signature-256': signature })).toBe(true)
		expect(await verify('github-sha256', { 'X-Hub-Signature-256': signature.toUpperCase().replace('SHA256=', 'sha256=') })).toBe(true)
		expect(await verify('github-sha256', { 'X-Hub-Signature-256': signature }, 'b'.repeat(64))).toBe(false)
		expect(await verify('github-sha256', { 'X-Hub-Signature-256': hmac('sha256', SECRET, raw, 'hex') })).toBe(false)
		expect(await verify('github-sha256', {})).toBe(false)
	})

	test('stripe: t and v1 over <t>.<body>, any v1 of a rotated secret, within five minutes', async () => {
		const secret = 'whsec_test'
		const signed = (t: string) => hmac('sha256', secret, `${t}.${raw}`, 'hex')
		expect(await verify('stripe', { 'Stripe-Signature': `t=${SECONDS},v1=${signed(SECONDS)},v0=00` }, secret)).toBe(true)
		expect(await verify('stripe', { 'Stripe-Signature': `t=${SECONDS},v1=${'0'.repeat(64)},v1=${signed(SECONDS)}` }, secret)).toBe(true)
		expect(await verify('stripe', { 'Stripe-Signature': `t=${SECONDS},v1=${signed(SECONDS)}` }, 'whsec_other')).toBe(false)
		const stale = String(Math.floor((NOW - WEBHOOK_TIMESTAMP_TOLERANCE_MS) / 1000) - 1)
		expect(await verify('stripe', { 'Stripe-Signature': `t=${stale},v1=${signed(stale)}` }, secret)).toBe(false)
		expect(await verify('stripe', { 'Stripe-Signature': `v1=${signed(SECONDS)}` }, secret)).toBe(false)
	})

	test('standard-webhooks: v1 over <id>.<timestamp>.<body> with the base64 key of a whsec_ secret', async () => {
		const key = Buffer.from('k'.repeat(32))
		const secret = `whsec_${key.toString('base64')}`
		const signature = hmac('sha256', key, `msg_1.${SECONDS}.${raw}`, 'base64')
		const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': SECONDS, 'webhook-signature': `v1,AAAA v1,${signature}` }
		expect(await verify('standard-webhooks', headers, secret)).toBe(true)
		expect(await verify('standard-webhooks', { ...headers, 'webhook-id': 'msg_2' }, secret)).toBe(false)
		expect(await verify('standard-webhooks', headers, key.toString('base64'))).toBe(false)
		expect(await verify('standard-webhooks', headers, secret, NOW + WEBHOOK_TIMESTAMP_TOLERANCE_MS + 1000)).toBe(false)
	})
})

describe('framework-owned shapes', () => {
	test('hmac over the body: the declared header, algorithm, encoding and prefix', async () => {
		const scheme: WebhookScheme = { hmac: { header: 'X-Shopify-Hmac-Sha256', algorithm: 'sha256', encoding: 'base64', signed: 'body' } }
		expect(await verify(scheme, { 'X-Shopify-Hmac-Sha256': hmac('sha256', SECRET, raw, 'base64') })).toBe(true)
		expect(await verify(scheme, { 'X-Shopify-Hmac-Sha256': hmac('sha256', SECRET, raw, 'hex') })).toBe(false)
		const sha1: WebhookScheme = { hmac: { header: 'X-Signature', algorithm: 'sha1', encoding: 'hex', prefix: 'sha1=', signed: 'body' } }
		expect(await verify(sha1, { 'X-Signature': `sha1=${hmac('sha1', SECRET, raw, 'hex')}` })).toBe(true)
		expect(await verify(sha1, { 'X-Signature': hmac('sha1', SECRET, raw, 'hex') })).toBe(false)
	})

	test('hmac over <id>.<timestamp>.<body>: both headers are signed, and the timestamp is fresh', async () => {
		const scheme: WebhookScheme = {
			hmac: { header: 'X-Sig', algorithm: 'sha512', encoding: 'hex', timestamp: 'X-Time', id: 'X-Id', signed: 'timestamp.body' },
		}
		const signature = hmac('sha512', SECRET, `d-1.${SECONDS}.${raw}`, 'hex')
		expect(await verify(scheme, { 'X-Sig': signature, 'X-Time': SECONDS, 'X-Id': 'd-1' })).toBe(true)
		expect(await verify(scheme, { 'X-Sig': signature, 'X-Time': SECONDS, 'X-Id': 'd-2' })).toBe(false)
		expect(await verify(scheme, { 'X-Sig': signature, 'X-Time': SECONDS })).toBe(false)
		expect(await verify(scheme, { 'X-Sig': signature, 'X-Time': SECONDS, 'X-Id': 'd-1' }, SECRET, NOW + 10 * 60 * 1000)).toBe(false)
	})

	test('basic: the password is the secret; bearer: the token is the secret', async () => {
		const basic = (credentials: string) => ({ Authorization: `Basic ${Buffer.from(credentials).toString('base64')}` })
		expect(await verify({ basic: true }, basic(`any-user:${SECRET}`))).toBe(true)
		expect(await verify({ basic: true }, basic(`${SECRET}:wrong`))).toBe(false)
		expect(await verify({ basic: true }, basic(SECRET))).toBe(false)
		expect(await verify({ basic: true }, { Authorization: `Bearer ${SECRET}` })).toBe(false)
		expect(await verify({ bearer: true }, { Authorization: `Bearer ${SECRET}` })).toBe(true)
		expect(await verify({ bearer: true }, { Authorization: `Bearer ${SECRET}x` })).toBe(false)
		expect(await verify({ bearer: true }, {})).toBe(false)
	})
})
