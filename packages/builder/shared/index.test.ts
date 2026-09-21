import { expect, test } from 'bun:test'
import {
	builderProjectPath,
	parseBuilderPairingState,
	parseBuilderPlatformStatus,
	parseBuilderProjectConfig,
	parsePreviewProjectInput,
} from './index'

test('existing project configs survive parsing without new optional fields', () => {
	const config = { profile: 'zerops-app', sessionId: 'session-1', createdAt: '2026-09-21T00:00:00.000Z' }
	expect(parseBuilderProjectConfig(config)).toEqual(config)
	for (
		const invalid of [
			null,
			{ ...config, sessionId: '' },
			{ ...config, createdAt: 'yesterday' },
			{ ...config, connection: null },
			{ ...config, previewUrl: 'javascript:alert(1)' },
			{ ...config, credential: 'secret' },
		]
	) {
		expect(() => parseBuilderProjectConfig(invalid)).toThrow(Error)
	}
})

test('status parsing requires the complete sanitized response', () => {
	const status = {
		sessionId: 'session-1',
		projectRoot: '/work/project',
		connection: null,
		credential: { available: false, expiresAt: null },
		pairing: null,
		previewUrl: null,
		deployment: null,
	}
	expect(parseBuilderPlatformStatus(status)).toEqual(status)
	expect(() => parseBuilderPlatformStatus({ ...status, credential: { available: true, expiresAt: Infinity } })).toThrow(Error)
	expect(() => parseBuilderPlatformStatus({ ...status, credential: { available: true, expiresAt: null, key: 'secret' } })).toThrow(Error)
	expect(() => parseBuilderPlatformStatus({ ...status, pairing: undefined })).toThrow(Error)
})

test('pairing variants reject fields that could leak credentials', () => {
	expect(parseBuilderPairingState({ status: 'approved' })).toEqual({ status: 'approved' })
	expect(() => parseBuilderPairingState({ status: 'approved', key: 'secret' })).toThrow(Error)
	expect(() => parseBuilderPairingState({ status: 'connected', authorizationUrl: 'https://iam.example/approve#proof' })).toThrow(Error)
	expect(() => parseBuilderPairingState({ status: 'pending', authorizationUrl: 'http://iam.example/approve#proof', expiresAt: 100 })).toThrow(Error)
})

test('preview clearing is explicit and project IDs cannot inject route segments', () => {
	expect(parsePreviewProjectInput({ url: null })).toEqual({ url: null })
	expect(() => parsePreviewProjectInput({})).toThrow(Error)
	expect(builderProjectPath('project/with?separator', 'platform')).toBe('/api/project/project%2Fwith%3Fseparator/platform')
})
