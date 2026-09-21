import { type BuilderConnectionReceiptDto, parseBuilderConnectionReceipt } from '@fabrika/control-contract'
import { parseBuilderOrigin, parseBuilderPreviewUrl } from './urls'

export { parseBuilderOrigin, parseBuilderPreviewUrl } from './urls'

export interface BuilderProjectConnection {
	controlOrigin: string
	iamIssuer: string
	receipt: BuilderConnectionReceiptDto
}

export interface BuilderProjectConfig {
	profile: string
	sessionId: string
	createdAt: string
	connection?: BuilderProjectConnection
	previewUrl?: string
}

export type BuilderPairingState =
	// Only the browser approval proof belongs in this URL's fragment; redemption credentials stay daemon-local.
	| { status: 'pending'; authorizationUrl: string; expiresAt: number }
	| { status: 'approved' }
	| { status: 'failed'; message: string }
	| { status: 'expired' }
	| { status: 'cancelled' }
	| { status: 'recovery_required'; message: string }
	| { status: 'connected' }

export interface BuilderDeploymentState {
	status: 'preparing' | 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
	runId: string | null
	commitSha: string | null
	message: string | null
	appUrl: string | null
	consoleUrl: string | null
}

export interface BuilderPlatformStatus {
	sessionId: string
	projectRoot: string
	connection: BuilderProjectConnection | null
	credential: { available: boolean; expiresAt: number | null }
	pairing: BuilderPairingState | null
	previewUrl: string | null
	deployment: BuilderDeploymentState | null
}

export interface RegisterProjectInput {
	projectRoot: string
}

export interface ConnectProjectInput {
	controlOrigin: string
}

export interface PreviewProjectInput {
	url: string | null
}

export interface BuilderErrorResponse {
	error: { code: string; message: string }
}

function object(value: unknown, fields: readonly string[], label: string): object {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
	for (const key of Object.keys(value)) {
		if (!fields.includes(key)) throw new Error(`${label} contains an unknown field`)
	}
	return value
}

function field(value: object, key: string): unknown {
	return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

function string(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
	return value
}

function timestamp(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`)
	return value
}

function nullableString(value: unknown, label: string): string | null {
	return value === null ? null : string(value, label)
}

function nullableUrl(value: unknown): string | null {
	return value === null ? null : parseBuilderPreviewUrl(value)
}

export function parseBuilderProjectConnection(value: unknown): BuilderProjectConnection {
	const input = object(value, ['controlOrigin', 'iamIssuer', 'receipt'], 'project connection')
	return {
		controlOrigin: parseBuilderOrigin(field(input, 'controlOrigin'), 'control origin'),
		iamIssuer: parseBuilderOrigin(field(input, 'iamIssuer'), 'IAM issuer'),
		receipt: parseBuilderConnectionReceipt(field(input, 'receipt')),
	}
}

export function parseBuilderProjectConfig(value: unknown): BuilderProjectConfig {
	const input = object(value, ['profile', 'sessionId', 'createdAt', 'connection', 'previewUrl'], 'project config')
	const createdAt = string(field(input, 'createdAt'), 'createdAt')
	if (!Number.isFinite(Date.parse(createdAt))) throw new Error('createdAt must be a date-time string')
	return {
		profile: string(field(input, 'profile'), 'profile'),
		sessionId: string(field(input, 'sessionId'), 'sessionId'),
		createdAt,
		...(Object.hasOwn(input, 'connection') ? { connection: parseBuilderProjectConnection(field(input, 'connection')) } : {}),
		...(Object.hasOwn(input, 'previewUrl') ? { previewUrl: parseBuilderPreviewUrl(field(input, 'previewUrl')) } : {}),
	}
}

export function parseBuilderPairingState(value: unknown): BuilderPairingState {
	const input = object(value, ['status', 'authorizationUrl', 'expiresAt', 'message'], 'pairing state')
	const status = field(input, 'status')
	switch (status) {
		case 'pending': {
			object(value, ['status', 'authorizationUrl', 'expiresAt'], 'pending pairing')
			const authorizationUrl = parseBuilderPreviewUrl(field(input, 'authorizationUrl'))
			parseBuilderOrigin(new URL(authorizationUrl).origin, 'authorization origin')
			return { status, authorizationUrl, expiresAt: timestamp(field(input, 'expiresAt'), 'pairing expiresAt') }
		}
		case 'failed':
		case 'recovery_required':
			object(value, ['status', 'message'], 'pairing state')
			return { status, message: string(field(input, 'message'), 'pairing message') }
		case 'approved':
		case 'expired':
		case 'cancelled':
		case 'connected':
			object(value, ['status'], 'pairing state')
			return { status }
		default:
			throw new Error('pairing status is invalid')
	}
}

export function parseBuilderDeploymentState(value: unknown): BuilderDeploymentState {
	const input = object(value, ['status', 'runId', 'commitSha', 'message', 'appUrl', 'consoleUrl'], 'deployment state')
	const status = field(input, 'status')
	if (
		status !== 'preparing' && status !== 'pending' && status !== 'running' && status !== 'succeeded' && status !== 'failed' && status !== 'cancelled'
	) {
		throw new Error('deployment status is invalid')
	}
	return {
		status,
		runId: nullableString(field(input, 'runId'), 'runId'),
		commitSha: nullableString(field(input, 'commitSha'), 'commitSha'),
		message: nullableString(field(input, 'message'), 'deployment message'),
		appUrl: nullableUrl(field(input, 'appUrl')),
		consoleUrl: nullableUrl(field(input, 'consoleUrl')),
	}
}

export function parseBuilderPlatformStatus(value: unknown): BuilderPlatformStatus {
	const input = object(value, ['sessionId', 'projectRoot', 'connection', 'credential', 'pairing', 'previewUrl', 'deployment'], 'platform status')
	const credential = object(field(input, 'credential'), ['available', 'expiresAt'], 'credential status')
	const available = field(credential, 'available')
	if (typeof available !== 'boolean') throw new Error('credential available must be a boolean')
	return {
		sessionId: string(field(input, 'sessionId'), 'sessionId'),
		projectRoot: string(field(input, 'projectRoot'), 'projectRoot'),
		connection: field(input, 'connection') === null ? null : parseBuilderProjectConnection(field(input, 'connection')),
		credential: {
			available,
			expiresAt: field(credential, 'expiresAt') === null ? null : timestamp(field(credential, 'expiresAt'), 'credential expiresAt'),
		},
		pairing: field(input, 'pairing') === null ? null : parseBuilderPairingState(field(input, 'pairing')),
		previewUrl: nullableUrl(field(input, 'previewUrl')),
		deployment: field(input, 'deployment') === null ? null : parseBuilderDeploymentState(field(input, 'deployment')),
	}
}

export function parseRegisterProjectInput(value: unknown): RegisterProjectInput {
	const input = object(value, ['projectRoot'], 'register input')
	return { projectRoot: string(field(input, 'projectRoot'), 'projectRoot') }
}

export function parseConnectProjectInput(value: unknown): ConnectProjectInput {
	const input = object(value, ['controlOrigin'], 'connect input')
	return { controlOrigin: parseBuilderOrigin(field(input, 'controlOrigin'), 'control origin') }
}

export function parsePreviewProjectInput(value: unknown): PreviewProjectInput {
	const input = object(value, ['url'], 'preview input')
	return { url: nullableUrl(field(input, 'url')) }
}

export function builderProjectPath(id: string, suffix: 'register' | 'platform' | 'connect' | 'disconnect' | 'deploy' | 'preview'): string {
	return `/api/project/${encodeURIComponent(string(id, 'project id'))}/${suffix}`
}
