/** Browser- and runtime-safe shapes at the direct Sentry-compatible ingest boundary. */

export const FABRIKA_OPERATIONS_DSN = 'FABRIKA_OPERATIONS_DSN'
export const FABRIKA_APP_ID = 'FABRIKA_APP_ID'
export const FABRIKA_ENVIRONMENT = 'FABRIKA_ENVIRONMENT'
export const FABRIKA_SERVICE_KEY = 'FABRIKA_SERVICE_KEY'

export type OperationsManagedEnvironmentKey =
	| typeof FABRIKA_OPERATIONS_DSN
	| typeof FABRIKA_APP_ID
	| typeof FABRIKA_ENVIRONMENT
	| typeof FABRIKA_SERVICE_KEY

export const OPERATIONS_MANAGED_ENVIRONMENT_KEYS: readonly OperationsManagedEnvironmentKey[] = [
	FABRIKA_OPERATIONS_DSN,
	FABRIKA_APP_ID,
	FABRIKA_ENVIRONMENT,
	FABRIKA_SERVICE_KEY,
]

export interface OperationsIngestConfiguration {
	dsn: string
	appId: string
	environment: string
	serviceKey: string
}

const PUBLIC_KEY_PATTERN = /^[0-9a-f]{32}$/
const INGEST_PROJECT_ID_PATTERN = /^[1-9][0-9]{0,18}$/

export function buildOperationsDsn(origin: string, publicKey: string, ingestProjectId: string): string {
	if (!PUBLIC_KEY_PATTERN.test(publicKey)) throw new Error('invalid Operations ingest public key')
	if (!INGEST_PROJECT_ID_PATTERN.test(ingestProjectId)) throw new Error('invalid Operations ingest project id')
	const url = new URL(origin)
	if (
		(url.protocol !== 'https:' && url.protocol !== 'http:')
		|| url.origin !== origin
		|| url.username !== ''
		|| url.password !== ''
	) {
		throw new Error('Operations ingest origin must be an HTTP origin')
	}
	url.username = publicKey
	url.pathname = `/${ingestProjectId}`
	return url.toString()
}

export function operationsEnvelopeUrl(origin: string, ingestProjectId: string): string {
	if (!INGEST_PROJECT_ID_PATTERN.test(ingestProjectId)) throw new Error('invalid Operations ingest project id')
	const url = new URL(origin)
	if (
		(url.protocol !== 'https:' && url.protocol !== 'http:')
		|| url.origin !== origin
		|| url.username !== ''
		|| url.password !== ''
	) {
		throw new Error('Operations ingest origin must be an HTTP origin')
	}
	url.pathname = `/api/${ingestProjectId}/envelope/`
	return url.toString()
}

export function operationsManagedEnvironment(input: OperationsIngestConfiguration): Record<OperationsManagedEnvironmentKey, string> {
	return {
		[FABRIKA_OPERATIONS_DSN]: input.dsn,
		[FABRIKA_APP_ID]: input.appId,
		[FABRIKA_ENVIRONMENT]: input.environment,
		[FABRIKA_SERVICE_KEY]: input.serviceKey,
	}
}

export function operationsManagedEnvironmentCollisions(keys: Iterable<string>): OperationsManagedEnvironmentKey[] {
	const occupied = new Set(keys)
	return OPERATIONS_MANAGED_ENVIRONMENT_KEYS.filter((key) => occupied.has(key))
}

export interface StackFrame {
	function?: string
	filename?: string
	module?: string
	absPath?: string
	line?: number
	column?: number
	inApp?: boolean
	preContext?: string[]
	contextLine?: string
	postContext?: string[]
}

export interface ParsedException {
	type: string
	value: string
	frames: StackFrame[]
}

export interface ParsedEvent {
	eventId: string
	projectId: string
	exception: ParsedException
	level: string
	release?: string
	environment?: string
	platform?: string
	tags: Record<string, string>
	sdkFingerprint: string[] | null
	receivedAt: number
	raw: Record<string, unknown>
}

export interface IngestMessage {
	projectId: string
	fingerprint: string
	eventId: string
	title: string
	culprit: string | null
	level: string
	release?: string
	environment?: string
	receivedAt: number
	payload: Record<string, unknown>
}

export type IngestRejectReason =
	| 'unauthorized'
	| 'forbidden'
	| 'too_large'
	| 'malformed'
	| 'unsupported'
	| 'rate_limited'
	| 'unavailable'
