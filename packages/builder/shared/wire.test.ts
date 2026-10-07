import { expect, test } from 'bun:test'
import type { PhaseState } from '../cli/src/derive'
import type { BuilderDeploymentState } from './index'
import {
	activeDaemonSchema,
	buildEventSchema,
	canvasFilesSchema,
	consumedFeedbackSchema,
	feedbackMetaSchema,
	healthInfoSchema,
	parseBuilderDeploymentState,
	parseBuilderPairingState,
	parseBuilderProjectConfig,
	phaseStateSchema,
	planResultSchema,
	sessionMetaSchema,
	sessionsSchema,
	skeletonsSchema,
	submitFeedbackSchema,
	uiHealthSchema,
	uiPhaseStateSchema,
	wsMessageSchema,
} from './index'

test('configuration preserves omission, whitespace and the legacy Date.parse vocabulary', () => {
	const config = { profile: ' app ', sessionId: ' session ', createdAt: 'October 5, 2026', previewUrl: 'https://example.test:443/view?q=1#review' }
	expect(parseBuilderProjectConfig(config)).toEqual({ ...config, previewUrl: 'https://example.test/view?q=1#review' })
	const legacy = { profile: 'app', sessionId: 'session', createdAt: '2026-10-05' }
	expect(Object.hasOwn(parseBuilderProjectConfig(legacy), 'connection')).toBe(false)
	for (const field of ['connection', 'previewUrl']) {
		expect(() => parseBuilderProjectConfig({ ...legacy, [field]: undefined })).toThrow()
		expect(() => parseBuilderProjectConfig({ ...legacy, [field]: null })).toThrow()
	}
})

test('all pairing variants preserve output and reject cross-variant fields without revealing their names or values', () => {
	const terminalStatuses: Array<'approved' | 'expired' | 'cancelled' | 'connected'> = ['approved', 'expired', 'cancelled', 'connected']
	for (const status of terminalStatuses) {
		expect(parseBuilderPairingState({ status })).toEqual({ status })
		expect(() => parseBuilderPairingState({ status, 'credential-secret': 'token-secret' })).toThrow('Invalid pairing state')
	}
	const failureStatuses: Array<'failed' | 'recovery_required'> = ['failed', 'recovery_required']
	for (const status of failureStatuses) {
		expect(parseBuilderPairingState({ status, message: ' retry ' })).toEqual({ status, message: ' retry ' })
		expect(() => parseBuilderPairingState({ status, message: ' ' })).toThrow()
	}
	expect(parseBuilderPairingState({ status: 'pending', authorizationUrl: 'https://iam.test:443/approve#proof', expiresAt: 1.5 }))
		.toEqual({ status: 'pending', authorizationUrl: 'https://iam.test/approve#proof', expiresAt: 1.5 })
	expect(() => parseBuilderPairingState({ status: 'pending', authorizationUrl: 'https://iam.test/approve', expiresAt: Infinity })).toThrow()
})

test('deployment requires explicit nulls and preserves run identity', () => {
	const deployment: BuilderDeploymentState = { status: 'running', runId: 'run-1', commitSha: 'abc', message: null, appUrl: null, consoleUrl: null }
	expect(parseBuilderDeploymentState(deployment)).toEqual(deployment)
	for (const field of ['runId', 'commitSha', 'message', 'appUrl', 'consoleUrl']) {
		expect(() => parseBuilderDeploymentState({ ...deployment, [field]: undefined })).toThrow()
	}
})

test('health consumers retain distinct sessions and malformed-field tolerance', () => {
	const sessionsDir = '/data/sessions'
	const health = { ok: true, version: false, pid: 1.5, sessions: 3, sessionsDir, extra: true }
	expect(healthInfoSchema.parse(health)).toEqual({ ok: true, pid: 1.5, sessions: 3, sessionsDir })
	expect(uiHealthSchema.parse(health)).toEqual({ ok: true })
	expect(activeDaemonSchema.parse(health)).toEqual({ ok: true, sessionsDir })
	for (const value of [{ ok: true }, { ok: true, sessionsDir: false }]) {
		expect(activeDaemonSchema.safeParse(value).success).toBe(false)
		expect(healthInfoSchema.safeParse(value).success).toBe(false)
	}
	expect(healthInfoSchema.safeParse({ ok: false, sessionsDir }).success).toBe(false)
	expect(healthInfoSchema.parse({ ok: true, sessions: ['one', 2], sessionsDir })).toEqual({ ok: true, sessionsDir })
})

test('CLI phase projection drops gateName while UI retains explicit null and omits malformed fields', () => {
	const phase: PhaseState = { current: 'intake', index: 0.5, completed: [], reads: [], produces: [], gate: true, satisfied: false }
	expect(phaseStateSchema.parse({ ...phase, gateName: 'intake' })).toEqual(phase)
	expect(uiPhaseStateSchema.parse({ ...phase, gateName: null })).toEqual({ ...phase, gateName: null })
	expect(uiPhaseStateSchema.parse({ ...phase, gateName: 12 })).toEqual(phase)
	expect(phaseStateSchema.safeParse({ ...phase, completed: ['unknown'] }).success).toBe(false)
})

test('plan and build projections omit invalid fields rather than rejecting usable data', () => {
	expect(planResultSchema.parse({ ok: false, errors: { file: 'compile failed' }, error: 5, canvasFiles: ['one', 2], revision: 0.5 }))
		.toEqual({ ok: false, errors: { file: 'compile failed' }, revision: 0.5 })
	expect(planResultSchema.parse({ ok: true, errors: { file: 2 }, gate: undefined })).toEqual({ ok: true })
	expect(buildEventSchema.parse({ status: 'running', issue: 'ISSUE-1', at: false, message: null, data: { extension: [1, null] }, ts: 5 }))
		.toEqual({ status: 'running', issue: 'ISSUE-1', data: { extension: [1, null] } })
	expect(buildEventSchema.safeParse({ status: 'unknown' }).success).toBe(false)
})

test('metadata recovers valid legacy entries and retains empty labels', () => {
	expect(
		canvasFilesSchema.parse(['legacy.jsx', '', null, { filename: 'new.jsx', label: 4 }, {
			filename: 'diff.jsx',
			diffStats: { added: 1, removed: 2, extra: true },
		}]),
	)
		.toEqual([{ filename: 'legacy.jsx' }, { filename: 'new.jsx' }, { filename: 'diff.jsx', diffStats: { added: 1, removed: 2 } }])
	expect(sessionMetaSchema.parse({
		currentRevision: 'bad',
		projectRoot: 3,
		revisions: [null, { revision: 0 }, {
			revision: 1,
			label: '',
			hasFeedback: 1,
			feedbackConsumed: true,
			canvasScope: { kind: 'view', filename: 'one.jsx' },
		}],
	})).toEqual({
		currentRevision: 0,
		canvasFiles: [],
		gate: null,
		revisions: [{
			revision: 1,
			label: '',
			canvasFiles: [],
			hasFeedback: false,
			feedbackConsumed: true,
			canvasScope: { kind: 'view', filename: 'one.jsx' },
		}],
	})
	expect(sessionsSchema.parse([null, { id: 'one', label: 3 }, { id: 2 }])).toEqual([{ id: 'one' }])
	expect(skeletonsSchema.parse({ skeletons: [null, { file: 'x', name: 'X', seeds: [], roles: [], steps: 1, invariants: 0, pending: 0, url: false }] }))
		.toEqual({ skeletons: [{ file: 'x', name: 'X', seeds: [], roles: [], steps: 1, invariants: 0, pending: 0 }] })
})

test('feedback projections preserve selection, permissive booleans and empty feedback recovery', () => {
	expect(feedbackMetaSchema.parse({ revisions: [null, { revision: 'bad' }, { revision: -1, hasFeedback: true, feedbackConsumed: 'true' }] }))
		.toEqual({ revisions: [{ revision: -1, hasFeedback: true, feedbackConsumed: false }] })
	expect(consumedFeedbackSchema.parse({ found: true, feedback: 3 })).toEqual({ found: true, feedback: '' })
	expect(consumedFeedbackSchema.safeParse({ found: false }).success).toBe(false)
	expect(submitFeedbackSchema.parse({ type: 'submit' })).toEqual({ type: 'submit', feedback: '' })
	expect(submitFeedbackSchema.safeParse({ type: 'other' }).success).toBe(false)
})

test('socket frames project supported variants and tolerate optional legacy canvas data', () => {
	expect(wsMessageSchema.parse({ type: 'plan-updated', currentRevision: 3, canvasFiles: ['one.jsx', null], gate: null, secret: 'drop' }))
		.toEqual({ type: 'plan-updated', currentRevision: 3, canvasFiles: [{ filename: 'one.jsx' }], gate: null })
	expect(wsMessageSchema.parse({ type: 'plan-updated', currentRevision: 3, canvasFiles: {}, gate: 4 }))
		.toEqual({ type: 'plan-updated', currentRevision: 3 })
	expect(wsMessageSchema.safeParse({ type: 'revision-updated', currentRevision: '3' }).success).toBe(false)
	expect(wsMessageSchema.parse({ type: 'phase-updated', extra: true })).toEqual({ type: 'phase-updated' })
})
