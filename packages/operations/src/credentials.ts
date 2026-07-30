import {
	buildOperationsDsn,
	type OperationsIngestConfiguration,
	operationsManagedEnvironment,
	type OperationsManagedEnvironmentKey,
} from '@fabrika/operations-contract/ingest'
import { credentialVerifier } from './pipeline.js'
import type { OperationsRepositories } from './repositories.js'
import { uuidv7 } from './uuid.js'

export const DEFAULT_INGEST_CREDENTIAL_OVERLAP_MS = 60 * 60 * 1_000
export const MAX_INGEST_CREDENTIAL_OVERLAP_MS = 7 * 24 * 60 * 60 * 1_000

export interface IssuedIngestCredential {
	id: string
	publicKey: string
	ingestProjectId: string
	dsn: string
	managedEnvironment: Record<OperationsManagedEnvironmentKey, string>
}

export interface IssueIngestCredentialOptions {
	now?: () => number
	publicKey?: () => string
	ingestProjectId?: () => string
	overlapMs?: number
}

export async function provisionSourceIngest(
	repositories: OperationsRepositories,
	input: { sourceId: string; operationsOrigin: string },
	options: IssueIngestCredentialOptions = {},
): Promise<IssuedIngestCredential> {
	return issueSourceIngest(repositories, input, { ...options, overlapMs: options.overlapMs ?? 0 })
}

export async function rotateSourceIngestCredential(
	repositories: OperationsRepositories,
	input: { sourceId: string; operationsOrigin: string },
	options: IssueIngestCredentialOptions = {},
): Promise<IssuedIngestCredential> {
	return issueSourceIngest(repositories, input, {
		...options,
		overlapMs: options.overlapMs ?? DEFAULT_INGEST_CREDENTIAL_OVERLAP_MS,
	})
}

async function issueSourceIngest(
	repositories: OperationsRepositories,
	input: { sourceId: string; operationsOrigin: string },
	options: IssueIngestCredentialOptions,
): Promise<IssuedIngestCredential> {
	const now = options.now ?? Date.now
	const overlapMs = options.overlapMs ?? 0
	if (!Number.isSafeInteger(overlapMs) || overlapMs < 0 || overlapMs > MAX_INGEST_CREDENTIAL_OVERLAP_MS) {
		throw new RangeError('credential overlap is outside the supported range')
	}
	const candidate = (options.ingestProjectId ?? generateIngestProjectId)()
	if (!/^[1-9][0-9]{0,18}$/.test(candidate)) throw new Error('generated ingest project id is invalid')
	const ingestProjectId = await repositories.sources.ensureIngestProjectId(input.sourceId, candidate)
	if (ingestProjectId === null) throw new Error('Operations source is unavailable for ingest')
	const source = await repositories.sources.get(input.sourceId)
	if (source?.enabled !== 1) throw new Error('Operations source is unavailable for ingest')

	const publicKey = (options.publicKey ?? generateIngestPublicKey)()
	if (!/^[0-9a-f]{32}$/.test(publicKey)) throw new Error('generated ingest public key is invalid')
	const issuedAt = now()
	const id = uuidv7(issuedAt)
	const stored = await repositories.sources.rotateCredential({
		id,
		sourceId: input.sourceId,
		verifier: await credentialVerifier(publicKey),
		overlapUntil: issuedAt + overlapMs,
	})
	if (!stored) throw new Error('Operations source is unavailable for ingest')
	const dsn = buildOperationsDsn(input.operationsOrigin, publicKey, ingestProjectId)
	const configuration: OperationsIngestConfiguration = {
		dsn,
		appId: source.app_id,
		environment: source.environment,
		serviceKey: source.service_key,
	}
	return {
		id,
		publicKey,
		ingestProjectId,
		dsn,
		managedEnvironment: operationsManagedEnvironment(configuration),
	}
}

export function generateIngestPublicKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	let value = ''
	for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
	return value
}

export function generateIngestProjectId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8))
	let value = 0n
	for (const byte of bytes) value = (value << 8n) | BigInt(byte)
	return (100_000_000_000_000_000n + value % 900_000_000_000_000_000n).toString()
}
