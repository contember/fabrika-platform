import { describe, expect, test } from 'bun:test'
import {
	buildParsedEvent,
	computeFingerprint,
	extractIngestKey,
	issueCulprit,
	issueTitle,
	parseEnvelope,
	parseEventEnvelope,
	parseIngestAuth,
	resolveFingerprint,
} from '../ingest.js'
import { buildSentryEnvelope } from '../testing.js'

describe('Sentry-compatible ingest kernel', () => {
	test('extracts DSN keys from both supported transports', () => {
		const queryKey = '0123456789abcdef0123456789abcdef'
		const headerKey = 'abcdef0123456789abcdef0123456789'
		expect(extractIngestKey(new Request(`https://ops.test/api/1/envelope/?sentry_key=${queryKey}`))).toBe(queryKey)
		expect(
			extractIngestKey(
				new Request('https://ops.test/api/1/envelope/', {
					headers: { 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${headerKey}, sentry_client=test` },
				}),
			),
		).toBe(headerKey)
		expect(parseIngestAuth(new Request(`https://ops.test/api/1/envelope/?sentry_key=${queryKey}&sentry_key=${queryKey}`))).toEqual({
			ok: false,
			reason: 'ambiguous',
		})
		expect(
			parseIngestAuth(
				new Request(`https://ops.test/api/1/envelope/?sentry_key=${queryKey}`, {
					headers: { 'x-sentry-auth': `Sentry sentry_key=${headerKey}` },
				}),
			),
		).toEqual({ ok: false, reason: 'ambiguous' })
	})

	test('parses length-delimited events and reports ignored item kinds', () => {
		const payload = JSON.stringify({ message: 'line one\\nline two' })
		const body = new TextEncoder().encode(
			`${JSON.stringify({ event_id: 'a'.repeat(32) })}\n`
				+ `${JSON.stringify({ type: 'attachment', length: 3 })}\nabc\n`
				+ `${JSON.stringify({ type: 'event', length: new TextEncoder().encode(payload).length })}\n${payload}\n`,
		)
		expect(parseEventEnvelope(body)).toEqual({
			eventPayloads: [{ message: 'line one\\nline two' }],
			ignoredItemTypes: ['attachment'],
		})
	})

	test('parses an envelope and preserves grouping inputs', async () => {
		const envelope = buildSentryEnvelope({
			type: 'TypeError',
			value: 'x is not a function',
			eventId: 'ABCDEF0123456789ABCDEF0123456789',
			frames: [
				{ function: 'vendor', module: 'vendor', inApp: false },
				{ function: 'render', module: 'app/card', inApp: true },
			],
		})
		const payload = parseEnvelope(envelope).eventPayload
		expect(payload).not.toBeNull()
		if (!payload) throw new Error('Expected an event payload.')
		const event = buildParsedEvent('app-web', payload, 1_722_340_000_000)
		expect(event).not.toBeNull()
		if (!event) throw new Error('Expected a parsed event.')
		expect(event.eventId).toBe('abcdef0123456789abcdef0123456789')
		expect(event.exception.frames).toHaveLength(2)
		expect(issueTitle(event.exception)).toBe('TypeError: x is not a function')
		expect(issueCulprit(event.exception)).toBe('render')
		expect(await computeFingerprint(event.exception)).toMatch(/^[0-9a-f]{64}$/)
	})

	test('honours SDK fingerprints and expands the default token', async () => {
		const envelope = buildSentryEnvelope({
			type: 'TypeError',
			value: 'first',
			frames: [{ function: 'render', module: 'app/card', inApp: true }],
			fingerprint: ['tenant-a', '{{ default }}'],
		})
		const payload = parseEnvelope(envelope).eventPayload
		if (!payload) throw new Error('Expected an event payload.')
		const event = buildParsedEvent('app-web', payload, 100)
		if (!event) throw new Error('Expected a parsed event.')
		const resolved = await resolveFingerprint(event)
		expect(resolved).toMatch(/^[0-9a-f]{64}$/)
		expect(resolved).not.toBe(await computeFingerprint(event.exception))
	})

	test('rejects malformed or non-event envelopes and accepts message events', () => {
		expect(parseEnvelope('{}\nnot-json\n{}\n').eventPayload).toBeNull()
		expect(parseEnvelope('{}\n{"type":"transaction"}\n{}\n').eventPayload).toBeNull()
		const payload = { event_id: 'unsafe/path', message: { formatted: 'worker stopped' } }
		const event = buildParsedEvent('worker', payload, 100)
		expect(event?.exception).toEqual({ type: 'Message', value: 'worker stopped', frames: [] })
		expect(event?.eventId).toMatch(/^[0-9a-f]{32}$/)
	})
})
