// The pure halves of the job runner: reading a cron schedule in UTC, and the envelope a job report sends to
// Operations' ingest.

import { describe, expect, spyOn, test } from 'bun:test'
import { jobEnvelope, operationsReporter, operationsTarget } from '../jobs/report'
import { parseCron, periodAt, previousDue } from '../jobs/schedule'

const utc = (text: string): Date => new Date(`${text}Z`)

function schedule(expression: string) {
	const parsed = parseCron(expression)
	if (parsed === null) {
		throw new Error(`${expression} did not parse`)
	}
	return parsed
}

describe('cron schedules', () => {
	test('the due minutes at or before a time, newest first', () => {
		expect(previousDue(schedule('0 3 * * *'), utc('2026-10-09T03:00:30'), 2)).toEqual([utc('2026-10-09T03:00:00'), utc('2026-10-08T03:00:00')])
		expect(previousDue(schedule('*/15 * * * *'), utc('2026-10-09T10:14:59'), 3)).toEqual([
			utc('2026-10-09T10:00:00'),
			utc('2026-10-09T09:45:00'),
			utc('2026-10-09T09:30:00'),
		])
		expect(previousDue(schedule('30 9-17/4 * * 1-5'), utc('2026-10-12T09:00:00'), 2)).toEqual([
			utc('2026-10-09T17:30:00'),
			utc('2026-10-09T13:30:00'),
		])
	})

	test('day of month and day of week both restricted: either matches, Sunday is 0 or 7', () => {
		expect(previousDue(schedule('0 0 13 * 5'), utc('2026-10-14T00:00:00'), 3)).toEqual([
			utc('2026-10-13T00:00:00'),
			utc('2026-10-09T00:00:00'),
			utc('2026-10-02T00:00:00'),
		])
		expect(previousDue(schedule('0 12 * * 7'), utc('2026-10-12T00:00:00'), 1)).toEqual([utc('2026-10-11T12:00:00')])
	})

	test('the period is the time between the two latest due minutes', () => {
		expect(periodAt(schedule('0 3 * * *'), utc('2026-10-09T12:00:00'))).toBe(24 * 3_600_000)
		expect(periodAt(schedule('0 7 * * 1'), utc('2026-10-09T12:00:00'))).toBe(7 * 24 * 3_600_000)
		expect(periodAt(schedule('0 0 30 2 *'), utc('2026-10-09T12:00:00'))).toBeNull()
	})

	test('anything but five fields of numbers, ranges, lists and steps does not parse', () => {
		for (
			const expression of [
				'0 3 * *',
				'60 * * * *',
				'* 24 * * *',
				'* * 0 * *',
				'* * * 13 *',
				'* * * * 8',
				'*/0 * * * *',
				'5-1 * * * *',
				'1-2-3 * * * *',
				'@daily',
			]
		) {
			expect(parseCron(expression)).toBeNull()
		}
		expect(parseCron('5/20 1,2 1-31 */3 0-7')).not.toBeNull()
	})
})

describe('job reports to Operations', () => {
	const dsn = 'https://0123456789abcdef0123456789abcdef@operations.test/42'

	test('the DSN names the envelope endpoint and the public key; anything else is no target', () => {
		expect(operationsTarget(dsn)).toEqual({ envelopeUrl: 'https://operations.test/api/42/envelope/', publicKey: '0123456789abcdef0123456789abcdef' })
		for (
			const invalid of ['https://operations.test/42', 'https://key@operations.test/42', 'ftp://0123456789abcdef0123456789abcdef@o.test/1', 'not a url']
		) {
			expect(operationsTarget(invalid)).toBeNull()
		}
	})

	test('a report is one error event with the fingerprint, the tags, the release and the environment', () => {
		const text = jobEnvelope(
			{ fingerprint: ['fabrika-job-failed', 'purge'], type: 'JobFailed', message: "job 'purge' failed", tags: { job: 'purge' } },
			'v1',
			'prod',
			new Date('2026-10-09T03:00:00Z'),
		)
		const [header, item, payload, rest] = text.split('\n')
		expect(rest).toBe('')
		expect(JSON.parse(item ?? '')).toEqual({ type: 'event' })
		const event = JSON.parse(payload ?? '')
		expect(JSON.parse(header ?? '')).toEqual({ event_id: event.event_id, sent_at: '2026-10-09T03:00:00.000Z' })
		expect(event).toEqual({
			event_id: expect.stringMatching(/^[0-9a-f]{32}$/),
			timestamp: '2026-10-09T03:00:00.000Z',
			level: 'error',
			platform: 'javascript',
			logger: 'fabrika.jobs',
			fingerprint: ['fabrika-job-failed', 'purge'],
			tags: { job: 'purge' },
			exception: { values: [{ type: 'JobFailed', value: "job 'purge' failed" }] },
			release: 'v1',
			environment: 'prod',
		})
	})

	test('the reporter posts with the ingest key, and a failed delivery is one log line, never a throw', async () => {
		const target = operationsTarget(dsn)
		if (target === null) throw new Error('no target')
		const sent: Request[] = []
		const report = { fingerprint: ['x'], type: 'JobMissed', message: 'm', tags: {} }
		await operationsReporter({
			target,
			release: null,
			environment: null,
			fetch: (request) => Promise.resolve(void sent.push(request)).then(() => new Response(null, { status: 202 })),
		}).report(report)
		expect(sent.map((request) => [request.url, request.headers.get('x-sentry-auth'), request.headers.get('content-type')])).toEqual([
			[
				'https://operations.test/api/42/envelope/',
				'Sentry sentry_version=7, sentry_key=0123456789abcdef0123456789abcdef',
				'application/x-sentry-envelope',
			],
		])
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			await operationsReporter({ target, release: null, environment: null, fetch: () => Promise.reject(new Error(`refused ${dsn}`)) }).report(report)
			expect(log.mock.calls.map((call) => String(call[0]))).toEqual(['fabrika: job report to Operations could not be delivered'])
		} finally {
			log.mockRestore()
		}
	})
})
