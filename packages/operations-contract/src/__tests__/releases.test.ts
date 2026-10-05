import { expect, test } from 'bun:test'
import {
	OperationsReleaseDecodeError,
	operationsReleasePayloadSchema,
	operationsReleaseRequestSchema,
	parseOperationsReleasePayload,
	parseOperationsReleaseRequest,
} from '../releases'

const payload = {
	runId: 'run:1',
	coordinate: { appId: 'app', environment: 'prod' },
	phase: 'started',
	providerRunId: null,
	outcome: null,
	artifactState: 'pending',
	release: { kind: 'available', name: '', commitSha: 'A'.repeat(40) },
	observedAt: 0,
}

test('release schemas produce the canonical bytes and omit explicitly undefined options', () => {
	const input = {
		...payload,
		coordinate: { ...payload.coordinate, serviceKey: undefined, extra: true },
		uploadCredential: undefined,
		extra: true,
	}
	const expected =
		'{"runId":"run:1","coordinate":{"appId":"app","environment":"prod"},"phase":"started","providerRunId":null,"outcome":null,"artifactState":"pending","release":{"kind":"available","name":"","commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"observedAt":0}'
	const parsed = parseOperationsReleasePayload(input)
	expect(JSON.stringify(parsed)).toBe(expected)
	expect(Object.hasOwn(parsed, 'uploadCredential')).toBe(false)
	expect(Object.hasOwn(parsed.coordinate, 'serviceKey')).toBe(false)
	expect(JSON.stringify(operationsReleasePayloadSchema.parse(input))).toBe(expected)
	expect(JSON.stringify(operationsReleaseRequestSchema.parse({ ...input, revision: 1, protocolVersion: 1 })))
		.toBe(`{"protocolVersion":1,"revision":1,${expected.slice(1)}`)
})

test('release errors retain structural and domain precedence', () => {
	const credential = { verifier: 'a'.repeat(64), expiresAt: 1 }
	const cases: [unknown, string][] = [
		[{ ...payload, coordinate: null }, 'invalid release request'],
		[{ ...payload, release: [] }, 'invalid release request'],
		[{ ...payload, runId: '', coordinate: {} }, 'invalid release request'],
		[{ ...payload, coordinate: {}, release: { kind: 'other' } }, 'invalid release coordinates'],
		[{ ...payload, release: { kind: 'available' }, uploadCredential: null }, 'invalid available release'],
		[{ ...payload, release: { kind: 'unavailable' }, uploadCredential: null }, 'invalid unavailable release'],
		[{ ...payload, release: { kind: 'other' }, uploadCredential: null }, 'invalid release availability'],
		[
			{ ...payload, phase: 'terminal', release: { kind: 'unavailable', reason: 'dry_run' }, uploadCredential: { ...credential, expiresAt: 0 } },
			'invalid upload credential',
		],
		[
			{ ...payload, phase: 'terminal', release: { kind: 'unavailable', reason: 'dry_run' }, uploadCredential: credential },
			'unavailable releases cannot accept artifacts',
		],
		[{ ...payload, phase: 'terminal' }, 'terminal release has no outcome'],
		[{ ...payload, outcome: 'failed' }, 'non-terminal release has an outcome'],
	]
	for (const [value, message] of cases) {
		expect(() => parseOperationsReleasePayload(value)).toThrow(OperationsReleaseDecodeError)
		expect(() => parseOperationsReleasePayload(value)).toThrow(message)
	}
	expect(() => parseOperationsReleaseRequest({ ...payload, revision: 0, protocolVersion: 1, coordinate: {} })).toThrow('invalid release request')
})

test('release schemas keep numeric bounds and both immutable commit widths', () => {
	for (const observedAt of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, Number.NaN]) {
		expect(() => parseOperationsReleasePayload({ ...payload, observedAt })).toThrow('invalid release request')
	}
	for (const length of [40, 64]) {
		expect(parseOperationsReleasePayload({ ...payload, release: { ...payload.release, commitSha: 'B'.repeat(length) } }).release)
			.toEqual({ kind: 'available', name: '', commitSha: 'b'.repeat(length) })
	}
	expect(parseOperationsReleasePayload({ ...payload, release: { kind: 'unavailable', reason: 'missing_commit', extension: true } }).release)
		.toEqual({ kind: 'unavailable', reason: 'missing_commit' })
})
