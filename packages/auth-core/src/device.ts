import { prop } from './json'
import type { Scope } from './types'

export interface StartDeviceAuthorizationInput {
	app: string
	label: string
	permissions: string[]
	keyLifetimeSeconds: number
	redemptionChallenge: string
	approvalChallenge: string
}
export interface DeviceAuthorizationStarted {
	attemptId: string
	expiresAt: number
	pollIntervalSeconds: 3
}
export interface DeviceAuthorizationProof {
	attemptId: string
	redemptionVerifier: string
}
export interface DeviceAuthorizationConsent {
	consentId: string
	app: string
	label: string
	permissions: string[]
	scope: Scope
	keyExpiresAt: number
}
export interface DeviceAuthorizationReceipt {
	attemptId: string
	consent: DeviceAuthorizationConsent
	credentialId: string
	principalId: string
	issuedAt: number
	revokedAt: number | null
}
export type DeviceAuthorizationTerminalStatus = 'denied' | 'cancelled' | 'expired' | 'authority_lost'
export type DeviceAuthorizationStatus =
	| { status: 'pending'; expiresAt: number }
	| { status: 'approved'; consent: DeviceAuthorizationConsent }
	| { status: 'issued'; receipt: DeviceAuthorizationReceipt }
	| { status: DeviceAuthorizationTerminalStatus }
export interface ExchangeDeviceAuthorizationInput extends DeviceAuthorizationProof {
	consentId: string
}
export type ExchangeDeviceAuthorizationResult =
	| { ok: true; token: string; receipt: DeviceAuthorizationReceipt }
	| { ok: false; reason: 'already_issued'; receipt: DeviceAuthorizationReceipt }
	| { ok: false; reason: 'invalid_attempt' | 'pending' | DeviceAuthorizationTerminalStatus | 'consent_mismatch' }
export interface DeviceAuthorizationCaller {
	app: string
	credential: string
	requestId: string
}
export interface InspectDeviceAuthorizationInput extends DeviceAuthorizationCaller {
	attemptId: string
	approvalVerifier: string
}
export interface DeviceAuthorizationRequest {
	attemptId: string
	app: string
	label: string
	permissions: string[]
	keyLifetimeSeconds: number
	expiresAt: number
}
export interface ApproveDeviceAuthorizationInput extends InspectDeviceAuthorizationInput {
	scope: Scope
}
export interface ListOwnDeviceAuthorizationsInput extends DeviceAuthorizationCaller {
	before?: string
	limit?: number
}
export interface DeviceAuthorizationFailure {
	ok: false
	reason: 'invalid_attempt' | 'not_allowed' | 'invalid_input' | 'expired' | 'conflict' | 'authority_lost'
}
export type InspectDeviceAuthorizationResult = { ok: true; request: DeviceAuthorizationRequest } | DeviceAuthorizationFailure
export type ApproveDeviceAuthorizationResult = { ok: true; consent: DeviceAuthorizationConsent } | DeviceAuthorizationFailure
export type DenyDeviceAuthorizationResult = { ok: true } | DeviceAuthorizationFailure
export type ListOwnDeviceAuthorizationsResult =
	| { ok: true; items: DeviceAuthorizationReceipt[]; nextCursor: string | null }
	| DeviceAuthorizationFailure
export type StartDeviceAuthorizationResult = { ok: true } & DeviceAuthorizationStarted | {
	ok: false
	reason: 'invalid_input' | 'not_allowed' | 'rate_limited'
}
export type PollDeviceAuthorizationResult = { ok: true } & DeviceAuthorizationStatus | { ok: false; reason: 'invalid_attempt' | 'slow_down' }
export type CancelDeviceAuthorizationResult = { ok: true } | { ok: false; reason: 'invalid_attempt' | 'already_issued' }

function text(value: unknown, max = 200): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= max
}
function seconds(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function id(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}
function proof(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}
function audience(value: unknown): value is string {
	return text(value, 100) && /^[a-z0-9][a-z0-9-]*$/.test(value)
}
function actions(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.length <= 32
		&& value.every((item: unknown) => text(item, 100) && /^[a-zA-Z0-9_.*-]+$/.test(item)) && new Set(value).size === value.length
}
function scope(value: unknown): Scope | null {
	const type = prop(value, 'type')
	const valueField = prop(value, 'value')
	return text(type, 100) && text(valueField, 200) ? { type, value: valueField } : null
}
export function parseStartDeviceAuthorizationInput(value: unknown): StartDeviceAuthorizationInput | null {
	const app = prop(value, 'app')
	const label = prop(value, 'label')
	const permissions = prop(value, 'permissions')
	const keyLifetimeSeconds = prop(value, 'keyLifetimeSeconds')
	const redemptionChallenge = prop(value, 'redemptionChallenge')
	const approvalChallenge = prop(value, 'approvalChallenge')
	return audience(app) && text(label) && actions(permissions) && seconds(keyLifetimeSeconds) && proof(redemptionChallenge) && proof(approvalChallenge)
			&& redemptionChallenge !== approvalChallenge
		? { app, label, permissions, keyLifetimeSeconds, redemptionChallenge, approvalChallenge }
		: null
}
export function parseDeviceAuthorizationStarted(value: unknown): DeviceAuthorizationStarted | null {
	const attemptId = prop(value, 'attemptId')
	const expiresAt = prop(value, 'expiresAt')
	return id(attemptId) && seconds(expiresAt) && prop(value, 'pollIntervalSeconds') === 3 ? { attemptId, expiresAt, pollIntervalSeconds: 3 } : null
}
export function parseDeviceAuthorizationProof(value: unknown): DeviceAuthorizationProof | null {
	const attemptId = prop(value, 'attemptId')
	const redemptionVerifier = prop(value, 'redemptionVerifier')
	return id(attemptId) && proof(redemptionVerifier) ? { attemptId, redemptionVerifier } : null
}
export function parseExchangeDeviceAuthorizationInput(value: unknown): ExchangeDeviceAuthorizationInput | null {
	const parsed = parseDeviceAuthorizationProof(value)
	const consentId = prop(value, 'consentId')
	return parsed && id(consentId) ? { ...parsed, consentId } : null
}
export function parseDeviceAuthorizationConsent(value: unknown): DeviceAuthorizationConsent | null {
	const consentId = prop(value, 'consentId')
	const app = prop(value, 'app')
	const label = prop(value, 'label')
	const permissions = prop(value, 'permissions')
	const parsedScope = scope(prop(value, 'scope'))
	const keyExpiresAt = prop(value, 'keyExpiresAt')
	return id(consentId) && audience(app) && text(label) && actions(permissions) && parsedScope && seconds(keyExpiresAt)
		? { consentId, app, label, permissions, scope: parsedScope, keyExpiresAt }
		: null
}
export function parseDeviceAuthorizationReceipt(value: unknown): DeviceAuthorizationReceipt | null {
	const attemptId = prop(value, 'attemptId')
	const credentialId = prop(value, 'credentialId')
	const principalId = prop(value, 'principalId')
	const consent = parseDeviceAuthorizationConsent(prop(value, 'consent'))
	const issuedAt = prop(value, 'issuedAt')
	const revokedAt = prop(value, 'revokedAt')
	return id(attemptId) && id(credentialId) && id(principalId) && consent && seconds(issuedAt) && (revokedAt === null || seconds(revokedAt))
		? { attemptId, credentialId, principalId, consent, issuedAt, revokedAt }
		: null
}
export function parseDeviceAuthorizationRequest(value: unknown): DeviceAuthorizationRequest | null {
	const attemptId = prop(value, 'attemptId')
	const app = prop(value, 'app')
	const label = prop(value, 'label')
	const permissions = prop(value, 'permissions')
	const keyLifetimeSeconds = prop(value, 'keyLifetimeSeconds')
	const expiresAt = prop(value, 'expiresAt')
	return id(attemptId) && audience(app) && text(label) && actions(permissions) && seconds(keyLifetimeSeconds) && keyLifetimeSeconds <= 2592000
			&& seconds(expiresAt)
		? { attemptId, app, label, permissions, keyLifetimeSeconds, expiresAt }
		: null
}
export function parseDeviceAuthorizationCaller(value: unknown): DeviceAuthorizationCaller | null {
	const app = prop(value, 'app')
	const credential = prop(value, 'credential')
	const requestId = prop(value, 'requestId')
	return audience(app) && text(credential, 16384) && text(requestId) ? { app, credential, requestId } : null
}
export function parseInspectDeviceAuthorizationInput(value: unknown): InspectDeviceAuthorizationInput | null {
	const caller = parseDeviceAuthorizationCaller(value)
	const attemptId = prop(value, 'attemptId')
	const approvalVerifier = prop(value, 'approvalVerifier')
	return caller && id(attemptId) && proof(approvalVerifier) ? { ...caller, attemptId, approvalVerifier } : null
}
export function parseApproveDeviceAuthorizationInput(value: unknown): ApproveDeviceAuthorizationInput | null {
	const inspect = parseInspectDeviceAuthorizationInput(value)
	const parsedScope = scope(prop(value, 'scope'))
	return inspect && parsedScope ? { ...inspect, scope: parsedScope } : null
}
export function parseListOwnDeviceAuthorizationsInput(value: unknown): ListOwnDeviceAuthorizationsInput | null {
	const caller = parseDeviceAuthorizationCaller(value)
	const before = prop(value, 'before')
	const limit = prop(value, 'limit')
	if (!caller || (before !== undefined && !id(before)) || (limit !== undefined && (!seconds(limit) || limit > 100))) return null
	return { ...caller, ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) }
}
function terminal(value: unknown): value is DeviceAuthorizationTerminalStatus {
	return value === 'denied' || value === 'cancelled' || value === 'expired' || value === 'authority_lost'
}
export function parseDeviceAuthorizationStatus(value: unknown): DeviceAuthorizationStatus | null {
	const status = prop(value, 'status')
	if (terminal(status)) return { status }
	if (status === 'pending') {
		const expiresAt = prop(value, 'expiresAt')
		return seconds(expiresAt) ? { status, expiresAt } : null
	}
	if (status === 'approved') {
		const consent = parseDeviceAuthorizationConsent(prop(value, 'consent'))
		return consent ? { status, consent } : null
	}
	if (status === 'issued') {
		const receipt = parseDeviceAuthorizationReceipt(prop(value, 'receipt'))
		return receipt ? { status, receipt } : null
	}
	return null
}
export function parseExchangeDeviceAuthorizationResult(value: unknown): ExchangeDeviceAuthorizationResult | null {
	const ok = prop(value, 'ok')
	const reason = prop(value, 'reason')
	if (ok === true || (ok === false && reason === 'already_issued')) {
		const receipt = parseDeviceAuthorizationReceipt(prop(value, 'receipt'))
		if (!receipt) return null
		if (ok === false) return { ok, reason: 'already_issued', receipt }
		const token = prop(value, 'token')
		return text(token, 200) && token.startsWith('px_') ? { ok, token, receipt } : null
	}
	return ok === false && (terminal(reason) || reason === 'invalid_attempt' || reason === 'pending' || reason === 'consent_mismatch')
		? { ok, reason }
		: null
}
export function parseStartDeviceAuthorizationResult(value: unknown): StartDeviceAuthorizationResult | null {
	if (prop(value, 'ok') === true) {
		const started = parseDeviceAuthorizationStarted(value)
		return started ? { ok: true, ...started } : null
	}
	const reason = prop(value, 'reason')
	return prop(value, 'ok') === false && (reason === 'invalid_input' || reason === 'not_allowed' || reason === 'rate_limited')
		? { ok: false, reason }
		: null
}
export function parsePollDeviceAuthorizationResult(value: unknown): PollDeviceAuthorizationResult | null {
	if (prop(value, 'ok') === true) {
		const status = parseDeviceAuthorizationStatus(value)
		return status ? { ok: true, ...status } : null
	}
	const reason = prop(value, 'reason')
	return prop(value, 'ok') === false && (reason === 'invalid_attempt' || reason === 'slow_down') ? { ok: false, reason } : null
}
export function parseCancelDeviceAuthorizationResult(value: unknown): CancelDeviceAuthorizationResult | null {
	if (prop(value, 'ok') === true) return { ok: true }
	const reason = prop(value, 'reason')
	return prop(value, 'ok') === false && (reason === 'invalid_attempt' || reason === 'already_issued') ? { ok: false, reason } : null
}
function failure(value: unknown): DeviceAuthorizationFailure | null {
	const reason = prop(value, 'reason')
	return prop(value, 'ok') === false
			&& (reason === 'invalid_attempt' || reason === 'not_allowed' || reason === 'invalid_input' || reason === 'expired' || reason === 'conflict'
				|| reason === 'authority_lost')
		? { ok: false, reason }
		: null
}
export function parseInspectDeviceAuthorizationResult(value: unknown): InspectDeviceAuthorizationResult | null {
	if (prop(value, 'ok') !== true) return failure(value)
	const request = parseDeviceAuthorizationRequest(prop(value, 'request'))
	return request ? { ok: true, request } : null
}
export function parseApproveDeviceAuthorizationResult(value: unknown): ApproveDeviceAuthorizationResult | null {
	if (prop(value, 'ok') !== true) return failure(value)
	const consent = parseDeviceAuthorizationConsent(prop(value, 'consent'))
	return consent ? { ok: true, consent } : null
}
export function parseDenyDeviceAuthorizationResult(value: unknown): DenyDeviceAuthorizationResult | null {
	return prop(value, 'ok') === true ? { ok: true } : failure(value)
}
export function parseListOwnDeviceAuthorizationsResult(value: unknown): ListOwnDeviceAuthorizationsResult | null {
	if (prop(value, 'ok') !== true) return failure(value)
	const raw = prop(value, 'items')
	const nextCursor = prop(value, 'nextCursor')
	if (!Array.isArray(raw) || raw.length > 100 || (nextCursor !== null && !id(nextCursor))) return null
	const items: DeviceAuthorizationReceipt[] = []
	for (const item of raw) {
		const receipt = parseDeviceAuthorizationReceipt(item)
		if (!receipt) return null
		items.push(receipt)
	}
	return { ok: true, items, nextCursor }
}
