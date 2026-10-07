import type { RunLogLine, RunnerStatus } from '@fabrika/runner-contract'
import { expect, test } from 'bun:test'
import { backstopPayloadSchema, parseRunLogLine, parseRunnerStatus } from '../protocol'

test('status and NDJSON keep IAM report bytes and strip undeclared fields', () => {
	const report = { app: 'app', schemaJson: ' { "scopes": [] } ' }
	const status = { runId: 'run', state: 'succeeded', startedAt: 1, iamReconcile: report } satisfies RunnerStatus
	expect(parseRunnerStatus({ ...status, iamReconcile: { ...report, extension: 1 }, extension: { future: true } }, 'run')).toEqual(status)
	const line = { ts: 1, stream: 'stdout', text: 'output' } satisfies RunLogLine
	expect(parseRunLogLine(JSON.stringify({ ...line, extension: true }))).toEqual(line)
})

test('status rejects malformed nested reports and explicit null optional fields', () => {
	const status = { runId: 'run', state: 'succeeded', startedAt: 1 }
	for (const patch of [{ iamReconcile: null }, { iamReconcile: { app: 42, schemaJson: '{}' } }, { exitCode: null }, { artifactState: 'unknown' }]) {
		expect(() => parseRunnerStatus({ ...status, ...patch }, 'run')).toThrow('runner returned malformed status')
	}
})

test('scheduled backstop payload requires a finite deadline and projects scheduling fields', () => {
	expect(backstopPayloadSchema.parse({ runId: 'run', deadline: 123, extra: true })).toEqual({ runId: 'run', deadline: 123 })
	for (const payload of [null, {}, { runId: 1, deadline: 123 }, { runId: 'run', deadline: '123' }, { runId: 'run', deadline: Infinity }]) {
		expect(backstopPayloadSchema.safeParse(payload).success).toBe(false)
	}
})
