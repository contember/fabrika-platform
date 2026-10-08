import { describe, expect, test } from 'bun:test'
import {
	parseApproveDeviceAuthorizationInput,
	parseDeviceAuthorizationReceipt,
	parseExchangeDeviceAuthorizationResult,
	parseListOwnDeviceAuthorizationsInput,
	parseListOwnDeviceAuthorizationsResult,
	parsePollDeviceAuthorizationResult,
	parseStartDeviceAuthorizationInput,
	parseStartDeviceAuthorizationResult,
} from '../device'

const start = {
	app: 'vozka',
	label: 'Local builder',
	permissions: ['app.manage', 'deploy.trigger', 'deploy.read'],
	keyLifetimeSeconds: 2592000,
	approvalChallenge: 'a'.repeat(43),
	redemptionChallenge: 'b'.repeat(43),
}
const receipt = {
	attemptId: '0199c3a0-0000-7000-8000-000000000001',
	credentialId: '0199c3a0-0000-7000-8000-000000000002',
	principalId: '0199c3a0-0000-7000-8000-000000000003',
	issuedAt: 1800000000,
	revokedAt: null,
	consent: {
		consentId: '0199c3a0-0000-7000-8000-000000000004',
		app: 'vozka',
		label: start.label,
		permissions: start.permissions,
		scope: { type: 'app', value: 'delivery-id' },
		keyExpiresAt: 1802592000,
	},
}

describe('device boundary parsers', () => {
	test('bounded inputs reject wrong types, duplicate actions, global scope and equal proofs', () => {
		expect(parseStartDeviceAuthorizationInput(start)).toEqual(start)
		for (
			const invalid of [
				{ ...start, permissions: [] },
				{ ...start, permissions: ['app.manage', 'app.manage'] },
				{ ...start, permissions: Array.from({ length: 33 }, (_, i) => `action.${i}`) },
				{ ...start, keyLifetimeSeconds: '2592000' },
				{ ...start, keyLifetimeSeconds: 1.5 },
				{ ...start, keyLifetimeSeconds: -1 },
				{ ...start, approvalChallenge: start.redemptionChallenge },
				{ ...start, redemptionChallenge: 'short' },
				{ ...start, label: 'x'.repeat(201) },
			]
		) expect(parseStartDeviceAuthorizationInput(invalid)).toBeNull()
		const caller = {
			app: 'vozka',
			credential: 'signed-token',
			requestId: 'req',
			attemptId: '0199c3a0-0000-7000-8000-000000000005',
			approvalVerifier: 'a'.repeat(43),
		}
		expect(parseApproveDeviceAuthorizationInput({ ...caller, scope: null })).toBeNull()
		expect(parseApproveDeviceAuthorizationInput({ ...caller, scope: { type: 'app', value: '' } })).toBeNull()
		expect(parseListOwnDeviceAuthorizationsInput({ ...caller, limit: 101 })).toBeNull()
		expect(parseListOwnDeviceAuthorizationsInput({ ...caller, before: 'not-an-id' })).toBeNull()
	})

	test('response parsers validate nested consent and receipt, never coerce malformed success', () => {
		expect(parseDeviceAuthorizationReceipt(receipt)).toEqual(receipt)
		expect(parseExchangeDeviceAuthorizationResult({ ok: true, token: 'px_secret', receipt })).toEqual({ ok: true, token: 'px_secret', receipt })
		expect(parseExchangeDeviceAuthorizationResult({ ok: false, reason: 'already_issued', receipt })).toEqual({
			ok: false,
			reason: 'already_issued',
			receipt,
		})
		expect(parseExchangeDeviceAuthorizationResult({ ok: false, reason: 'already_issued' })).toBeNull()
		expect(parseExchangeDeviceAuthorizationResult({ ok: true, receipt })).toBeNull()
		expect(parsePollDeviceAuthorizationResult({ ok: true, status: 'approved', consent: { ...receipt.consent, keyExpiresAt: '1802592000' } })).toBeNull()
		expect(parsePollDeviceAuthorizationResult({ ok: true, status: 'unknown' })).toBeNull()
		expect(parseDeviceAuthorizationReceipt({ ...receipt, revokedAt: undefined })).toBeNull()
		expect(parseDeviceAuthorizationReceipt({ ...receipt, consent: { ...receipt.consent, scope: null } })).toBeNull()
		expect(
			parseStartDeviceAuthorizationResult({
				ok: true,
				attemptId: '0199c3a0-0000-7000-8000-000000000006',
				expiresAt: 1800000000,
				pollIntervalSeconds: 2,
			}),
		).toBeNull()
		expect(parseListOwnDeviceAuthorizationsResult({ ok: true, items: [receipt], nextCursor: null })).toEqual({
			ok: true,
			items: [receipt],
			nextCursor: null,
		})
		expect(parseListOwnDeviceAuthorizationsResult({ ok: true, items: [receipt], nextCursor: 1 })).toBeNull()
	})
})
