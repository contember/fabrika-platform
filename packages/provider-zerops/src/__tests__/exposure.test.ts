import { describe, expect, test } from 'bun:test'
import { buildParsedEvent, parseEventEnvelope } from '../../../operations/src/ingest'
import { type ExposureAlert, exposureAlertRequest, formatStorageProvenance, parseStorageProvenance } from '../exposure'

const ALERT: ExposureAlert = {
	appId: 'notes',
	env: 'prod',
	release: 'fabrika/notes/prod/default/0123',
	findings: [{ hostname: 'notesapi', reason: 'has a `.zerops.app` subdomain' }],
}
const EVENT_ID = '0123456789abcdef0123456789abcdef'

describe('the Operations alert of a refused activation', () => {
	test('is an error event the Operations ingest accepts for the application project', () => {
		const request = exposureAlertRequest('https://0123456789abcdef0123456789abcdef@ops.example.test/42', ALERT, EVENT_ID)
		expect(request?.url).toBe('https://ops.example.test/api/42/envelope/?sentry_key=0123456789abcdef0123456789abcdef')
		const envelope = parseEventEnvelope(new TextEncoder().encode(request?.body ?? ''))
		const [payload] = envelope.eventPayloads
		if (payload === undefined) throw new Error('expected one event')
		const event = buildParsedEvent('42', payload)
		expect(event).toMatchObject({
			eventId: EVENT_ID,
			level: 'fatal',
			environment: 'prod',
			release: ALERT.release,
			exception: { type: 'FabrikaExposureRefused', value: 'zerops: activation refused; service `notesapi` has a `.zerops.app` subdomain' },
			sdkFingerprint: ['fabrika-exposure-refused', 'notes', 'prod', 'notesapi'],
		})
	})

	test('is not sent to a DSN of another form', () => {
		for (
			const dsn of ['not a url', 'https://ops.example.test/42', 'https://key@ops.example.test/42', 'ftp://0123456789abcdef0123456789abcdef@ops/42']
		) {
			expect(exposureAlertRequest(dsn, ALERT, EVENT_ID)).toBeNull()
		}
	})
})

describe('the bucket provenance marker', () => {
	test('round-trips a sorted set of service ids', () => {
		expect(formatStorageProvenance(['b', 'a', 'b'])).toBe('a,b')
		expect([...parseStorageProvenance('a,b')]).toEqual(['a', 'b'])
		expect(parseStorageProvenance(undefined).size).toBe(0)
		expect(parseStorageProvenance('').size).toBe(0)
	})
})
