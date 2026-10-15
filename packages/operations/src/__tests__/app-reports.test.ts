// The events `@fabrika/app` sends (ADR-0059) through Operations' own ingest parser: accepted, titled by the
// framework's exception, grouped by the explicit fingerprint whether or not the thrown error travels with it, and
// within the ingest's message limit even for the largest chain the application sends.

import { crashEnvelope, reportEnvelope, secretScrubber } from '@fabrika/app/implement'
import { describe, expect, test } from 'bun:test'
import { MAX_INGEST_MESSAGE_BYTES } from '../direct-ingest'
import { buildParsedEvent, issueCulprit, issueTitle, parseEventEnvelope, resolveFingerprint } from '../ingest'
import { prepareIngestMessage } from '../pipeline'

const options: Parameters<typeof reportEnvelope>[1] = { release: 'r1', environment: 'prod', source: 'fabrika.requests', scrubber: secretScrubber([]) }
const report = {
	fingerprint: ['fabrika-request-failed', 'api.me', 'handler_failed'],
	type: 'RequestFailed',
	message: "endpoint 'api.me' answered 500: handler_failed",
	tags: { endpoint: 'api.me', code: 'handler_failed', status: '500' },
}

function ingest(envelope: string) {
	const [payload] = parseEventEnvelope(new TextEncoder().encode(envelope)).eventPayloads
	if (payload === undefined) throw new Error('no event in the envelope')
	const parsed = buildParsedEvent('source-1', payload)
	if (parsed === null) throw new Error('the event was refused')
	return parsed
}

/** A chain as large as the application sends: every error with long frames and a long message. */
function hugeChain(): Error {
	const frame = (index: number) => `    at ${'handler'.repeat(80)}${index} (/var/www/src/${'slice/'.repeat(80)}endpoints.ts:${index}:7)`
	const stack = ['Error: x', ...Array.from({ length: 200 }, (_, index) => frame(index + 1))].join('\n')
	let error = new Error('m'.repeat(10_000))
	error.stack = stack
	for (let level = 0; level < 12; level++) {
		error = new Error('m'.repeat(10_000), { cause: error })
		error.stack = stack
	}
	return error
}

describe('an application report', () => {
	test('is accepted with its cause chain, titled by the framework exception, and grouped as before', async () => {
		const withError = ingest(reportEnvelope({ ...report, error: new TypeError('x is undefined') }, options, new Date()))
		const without = ingest(reportEnvelope(report, options, new Date()))
		expect(issueTitle(withError.exception)).toBe("RequestFailed: endpoint 'api.me' answered 500: handler_failed")
		expect(await resolveFingerprint(withError)).toBe(await resolveFingerprint(without))
		expect(withError.raw['exception']).toMatchObject({ values: [{ type: 'TypeError', value: 'x is undefined' }, { type: 'RequestFailed' }] })
		expect(withError.release).toBe('r1')
		expect(withError.tags).toEqual(report.tags)
	})

	test('stays within the ingest message limit for the largest chain', async () => {
		const parsed = ingest(reportEnvelope({ ...report, error: hugeChain() }, options, new Date()))
		const message = await prepareIngestMessage('source-1', parsed)
		expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(MAX_INGEST_MESSAGE_BYTES)
	})
})

describe('a crash report', () => {
	test('is titled and grouped by what was thrown: its type and in-app frames, not its message or line', async () => {
		const crash = (message: string, line: number) => {
			const error = new RangeError(message)
			error.stack = [
				`RangeError: ${message}`,
				`    at paginate (/var/www/src/notes/logic.ts:${line}:9)`,
				'    at <anonymous> (/var/www/node_modules/@fabrika/app/src/implement/dispatch.ts:300:11)',
			].join('\n')
			return ingest(crashEnvelope('unhandled_rejection', error, { ...options, source: 'fabrika.process' }, new Date()))
		}
		const first = crash('page 3 out of range', 12)
		const second = crash('page 9 out of range', 14)
		expect(issueTitle(first.exception)).toBe('RangeError: page 3 out of range')
		expect(issueCulprit(first.exception)).toBe('paginate')
		expect(first.exception.frames.map((frame) => frame.inApp)).toEqual([false, true])
		expect(first.tags).toEqual({ crash: 'unhandled_rejection' })
		expect(await resolveFingerprint(first)).toBe(await resolveFingerprint(second))
	})
})
