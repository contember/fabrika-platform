import {
	API_KEY_PREFIX,
	type ApproveDeviceAuthorizationResult,
	type CancelDeviceAuthorizationResult,
	type DenyDeviceAuthorizationResult,
	type DeviceAuthorizationCaller,
	type DeviceAuthorizationConsent,
	type DeviceAuthorizationReceipt,
	type DeviceAuthorizationStatus,
	type ExchangeDeviceAuthorizationResult,
	type InspectDeviceAuthorizationInput,
	type InspectDeviceAuthorizationResult,
	type ListOwnDeviceAuthorizationsResult,
	parseApproveDeviceAuthorizationInput,
	parseDeviceAuthorizationConsent,
	parseDeviceAuthorizationProof,
	parseDeviceAuthorizationReceipt,
	parseDeviceAuthorizationRequest,
	parseExchangeDeviceAuthorizationInput,
	parseInspectDeviceAuthorizationInput,
	parseListOwnDeviceAuthorizationsInput,
	parseStartDeviceAuthorizationInput,
	permits,
	type PollDeviceAuthorizationResult,
	type StartDeviceAuthorizationResult,
} from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { contractPatternsProblem } from './contract-rules'
import { auditLabelOf } from './db'
import type { Env } from './env'
import { pkceChallenge } from './oidc'
import type { DeviceAuthorizationRow, DeviceReceiptRow } from './repositories/device'
import { unixNow } from './repositories/sql'
import { resolvePermissionsAt } from './resolve'
import { generateToken, hashToken, timingSafeEqualHex } from './secret'
import type { Services } from './services'
import { getSigner, verifyAccessToken } from './signing'

async function human(services: Services, env: Env, input: DeviceAuthorizationCaller) {
	if (!services.config.adminAudiences.has(input.app) || input.credential.startsWith(API_KEY_PREFIX)) return null
	const claims = await verifyAccessToken(await getSigner(env), input.credential, { issuer: services.config.issuer, audience: input.app })
	if (claims?.ptype !== 'user') return null
	return activeHuman(services, claims.sub)
}

async function activeHuman(services: Services, id: string) {
	const principal = await services.repositories.principals.getPrincipalById(id)
	return principal?.type === 'user' && principal.disabled_at === null && principal.activated_at !== null ? principal : null
}

function requestFromRow(row: DeviceAuthorizationRow) {
	const request = parseDeviceAuthorizationRequest({
		attemptId: row.id,
		app: row.app,
		label: row.label,
		permissions: JSON.parse(row.permissions),
		keyLifetimeSeconds: row.key_lifetime_seconds,
		expiresAt: row.expires_at,
	})
	if (!request) throw new Error('Invalid stored device request')
	return request
}

function consentFromRow(row: DeviceAuthorizationRow): DeviceAuthorizationConsent {
	const consent = parseDeviceAuthorizationConsent({
		...requestFromRow(row),
		consentId: row.consent_id,
		scope: { type: row.scope_type, value: row.scope_value },
		keyExpiresAt: row.key_expires_at,
	})
	if (!consent) throw new Error('Invalid stored device consent')
	return consent
}

function receiptFromRow(row: DeviceReceiptRow): DeviceAuthorizationReceipt {
	const receipt = parseDeviceAuthorizationReceipt({
		attemptId: row.id,
		consent: consentFromRow(row),
		credentialId: row.credential_id,
		principalId: row.principal_id,
		issuedAt: row.issued_at,
		revokedAt: row.revoked_at,
	})
	if (!receipt) throw new Error('Invalid stored device receipt')
	return receipt
}

function status(row: DeviceReceiptRow): DeviceAuthorizationStatus {
	if (row.status === 'issued') return { status: 'issued', receipt: receiptFromRow(row) }
	if (row.expires_at <= unixNow()) return { status: 'expired' }
	if (row.status === 'approved') {
		const consent = consentFromRow(row)
		return consent.keyExpiresAt <= unixNow() ? { status: 'expired' } : { status: 'approved', consent }
	}
	if (row.status === 'pending') return { status: 'pending', expiresAt: row.expires_at }
	return { status: row.status }
}

async function validProof(verifier: string, challenge: string): Promise<boolean> {
	return timingSafeEqualHex(await hashToken(await pkceChallenge(verifier)), await hashToken(challenge))
}

async function inspectedRow(services: Services, input: InspectDeviceAuthorizationInput) {
	const row = await services.repositories.device.get(input.attemptId)
	return row && row.app === input.app && await validProof(input.approvalVerifier, row.approval_challenge) ? row : null
}

export async function startDeviceAuthorization(
	services: Services,
	raw: unknown,
	clientAddress: string | null,
): Promise<StartDeviceAuthorizationResult> {
	const input = parseStartDeviceAuthorizationInput(raw)
	if (!input) return { ok: false, reason: 'invalid_input' }
	if (!services.config.adminAudiences.has(input.app)) return { ok: false, reason: 'not_allowed' }
	const throttle = await services.repositories.passwords.recordLoginFailure({
		loginKeyHash: await hashToken(`device-start:${clientAddress === null ? 'installation' : `client:${clientAddress}`}`),
		windowSeconds: 600,
		maxAttempts: 21,
		blockSeconds: 600,
	})
	if (throttle.blocked_until !== null && throttle.blocked_until > unixNow()) return { ok: false, reason: 'rate_limited' }
	return { ok: true, ...await services.repositories.device.start(input) }
}

export async function pollDeviceAuthorization(services: Services, raw: unknown): Promise<PollDeviceAuthorizationResult> {
	const input = parseDeviceAuthorizationProof(raw)
	if (!input) return { ok: false, reason: 'invalid_attempt' }
	const row = await services.repositories.device.get(input.attemptId)
	if (!row || !await validProof(input.redemptionVerifier, row.redemption_challenge)) return { ok: false, reason: 'invalid_attempt' }
	if (!await services.repositories.device.poll(row.id, row.redemption_challenge)) return { ok: false, reason: 'slow_down' }
	const current = await services.repositories.device.get(row.id)
	return current ? { ok: true, ...status(current) } : { ok: false, reason: 'invalid_attempt' }
}

export async function cancelDeviceAuthorization(services: Services, raw: unknown): Promise<CancelDeviceAuthorizationResult> {
	const input = parseDeviceAuthorizationProof(raw)
	if (!input) return { ok: false, reason: 'invalid_attempt' }
	const row = await services.repositories.device.get(input.attemptId)
	if (!row || !await validProof(input.redemptionVerifier, row.redemption_challenge)) return { ok: false, reason: 'invalid_attempt' }
	await services.repositories.device.terminate(row.id, 'cancelled')
	const current = await services.repositories.device.get(row.id)
	return current?.status === 'issued' ? { ok: false, reason: 'already_issued' } : { ok: true }
}

export async function inspectDeviceAuthorization(services: Services, env: Env, raw: unknown): Promise<InspectDeviceAuthorizationResult> {
	const input = parseInspectDeviceAuthorizationInput(raw)
	if (!input) return { ok: false, reason: 'invalid_input' }
	if (!await human(services, env, input)) return { ok: false, reason: 'not_allowed' }
	const row = await inspectedRow(services, input)
	if (!row) return { ok: false, reason: 'invalid_attempt' }
	if (row.expires_at <= unixNow()) return { ok: false, reason: 'expired' }
	if (row.status !== 'pending' && row.status !== 'approved') return { ok: false, reason: 'conflict' }
	return { ok: true, request: requestFromRow(row) }
}

export async function approveDeviceAuthorization(services: Services, env: Env, raw: unknown): Promise<ApproveDeviceAuthorizationResult> {
	const input = parseApproveDeviceAuthorizationInput(raw)
	if (!input) return { ok: false, reason: 'invalid_input' }
	const principal = await human(services, env, input)
	if (!principal) return { ok: false, reason: 'not_allowed' }
	const row = await inspectedRow(services, input)
	if (!row) return { ok: false, reason: 'invalid_attempt' }
	if (row.expires_at <= unixNow()) return { ok: false, reason: 'expired' }
	const permissions = await resolvePermissionsAt(services, principal, row.app)
	const request = requestFromRow(row)
	if (!request.permissions.every((action) => permits(permissions, action, input.scope))) return { ok: false, reason: 'not_allowed' }
	// The key's grant is written by raw SQL at exchange (`repositories/device.ts`), so the write rule is checked here.
	if (await contractPatternsProblem(services.repositories.appSchema, row.app, request.permissions) !== null) {
		return { ok: false, reason: 'not_allowed' }
	}
	const consent: DeviceAuthorizationConsent = {
		consentId: uuidv7(),
		app: row.app,
		label: row.label,
		permissions: request.permissions,
		scope: input.scope,
		keyExpiresAt: unixNow() + row.key_lifetime_seconds,
	}
	if (await services.repositories.device.approve(row.id, principal.id, consent)) return { ok: true, consent }
	const current = await services.repositories.device.get(row.id)
	if (
		current?.status === 'approved' && current.approver_id === principal.id && current.scope_type === input.scope.type
		&& current.scope_value === input.scope.value
	) {
		return { ok: true, consent: consentFromRow(current) }
	}
	return { ok: false, reason: 'conflict' }
}

export async function denyDeviceAuthorization(services: Services, env: Env, raw: unknown): Promise<DenyDeviceAuthorizationResult> {
	const input = parseInspectDeviceAuthorizationInput(raw)
	if (!input) return { ok: false, reason: 'invalid_input' }
	const principal = await human(services, env, input)
	if (!principal) return { ok: false, reason: 'not_allowed' }
	const row = await inspectedRow(services, input)
	if (!row) return { ok: false, reason: 'invalid_attempt' }
	if (row.expires_at <= unixNow()) return { ok: false, reason: 'expired' }
	if (row.status !== 'pending' && row.status !== 'denied') return { ok: false, reason: 'conflict' }
	await services.repositories.device.deny(row.id)
	const current = await services.repositories.device.get(row.id)
	return current?.status === 'denied' ? { ok: true } : { ok: false, reason: 'conflict' }
}

export async function listOwnDeviceAuthorizations(services: Services, env: Env, raw: unknown): Promise<ListOwnDeviceAuthorizationsResult> {
	const input = parseListOwnDeviceAuthorizationsInput(raw)
	if (!input) return { ok: false, reason: 'invalid_input' }
	const principal = await human(services, env, input)
	if (!principal) return { ok: false, reason: 'not_allowed' }
	const limit = input.limit ?? 50
	const rows = await services.repositories.device.list(principal.id, input.app, input.before, limit + 1)
	const items = rows.slice(0, limit).map(receiptFromRow)
	return { ok: true, items, nextCursor: rows.length > limit ? items.at(-1)?.attemptId ?? null : null }
}

export async function exchangeDeviceAuthorization(services: Services, raw: unknown, requestId: string): Promise<ExchangeDeviceAuthorizationResult> {
	const input = parseExchangeDeviceAuthorizationInput(raw)
	if (!input) return { ok: false, reason: 'invalid_attempt' }
	const row = await services.repositories.device.get(input.attemptId)
	if (!row || !await validProof(input.redemptionVerifier, row.redemption_challenge)) return { ok: false, reason: 'invalid_attempt' }
	const currentStatus = status(row)
	if (currentStatus.status === 'issued') return { ok: false, reason: 'already_issued', receipt: currentStatus.receipt }
	if (currentStatus.status !== 'approved') return { ok: false, reason: currentStatus.status }
	const consent = currentStatus.consent
	if (consent.consentId !== input.consentId) return { ok: false, reason: 'consent_mismatch' }
	const principal = row.approver_id === null ? null : await activeHuman(services, row.approver_id)
	const permissions = principal
		? await resolvePermissionsAt(services, principal, row.app)
		: []
	if (
		!principal || !services.config.adminAudiences.has(row.app) || !consent.permissions.every((action) => permits(permissions, action, consent.scope))
		|| await contractPatternsProblem(services.repositories.appSchema, row.app, consent.permissions) !== null
	) {
		await services.repositories.device.terminate(row.id, 'authority_lost')
		const recovered = await services.repositories.device.get(row.id)
		return recovered?.status === 'issued'
			? { ok: false, reason: 'already_issued', receipt: receiptFromRow(recovered) }
			: { ok: false, reason: 'authority_lost' }
	}
	if (consent.keyExpiresAt <= unixNow()) return { ok: false, reason: 'expired' }
	const token = `${API_KEY_PREFIX}${generateToken()}`
	const issued = await services.repositories.device.issue({
		attemptId: row.id,
		consentId: consent.consentId,
		tokenHash: await hashToken(token),
		requestId,
		approverLabel: auditLabelOf(principal),
	})
	if (issued) return { ok: true, token, receipt: receiptFromRow({ ...issued, revoked_at: null }) }
	const recovered = await services.repositories.device.get(row.id)
	if (!recovered) return { ok: false, reason: 'invalid_attempt' }
	const latest = status(recovered)
	if (latest.status === 'issued') return { ok: false, reason: 'already_issued', receipt: latest.receipt }
	return { ok: false, reason: latest.status === 'approved' ? 'expired' : latest.status }
}
