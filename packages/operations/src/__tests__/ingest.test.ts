import { describe, expect, test } from 'bun:test'
import { buildSentryEnvelope } from '../testing.js'
import {
	buildParsedEvent,
	computeFingerprint,
	extractIngestKey,
	ingestKeyLookup,
	issueCulprit,
	issueTitle,
	parseEnvelope,
	resolveFingerprint,
} from '../ingest.js'

describe('Sentry-compatible ingest kernel', () => {
	test('extracts DSN keys from both supported transports', () => {
		expect(extractIngestKey(new Request('https://ops.test/api/app/envelope?sentry_key=query-key'))).toBe('query-key')
		expect(
			extractIngestKey(
				new Request('https://ops.test/api/app/envelope', {
					headers: { 'x-sentry-auth': 'Sentry sentry_version=7, sentry_key=header-key, sentry_client=test' },
				}),
			),
		).toBe('header-key')
		expect(ingestKeyLookup('header-key')).toBe('ingest-key:header-key')
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
