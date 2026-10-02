import type { JsonValue } from '@fabrika/provider-contract'

export const MANAGED_ENVIRONMENT_PREFIX = 'FABRIKA_MENV_'
export const MANAGED_ENVIRONMENT_MARKER = 'FABRIKA_MENV_PROTOCOL'
export const MANAGED_CHECKPOINT_MAX_BYTES = 16 * 1024

export type ManagedKey =
	| 'FABRIKA_RELEASE'
	| 'FABRIKA_OPERATIONS_DSN'
	| 'FABRIKA_IAM_ISSUER'
	| 'FABRIKA_APP_ID'
	| 'FABRIKA_ENVIRONMENT'
	| 'FABRIKA_SERVICE_KEY'

export const MANAGED_KEYS: readonly ManagedKey[] = [
	'FABRIKA_RELEASE',
	'FABRIKA_OPERATIONS_DSN',
	'FABRIKA_IAM_ISSUER',
	'FABRIKA_APP_ID',
	'FABRIKA_ENVIRONMENT',
	'FABRIKA_SERVICE_KEY',
]

const slots: Record<ManagedKey, string> = {
	FABRIKA_RELEASE: 'R',
	FABRIKA_OPERATIONS_DSN: 'D',
	FABRIKA_IAM_ISSUER: 'I',
	FABRIKA_APP_ID: 'A',
	FABRIKA_ENVIRONMENT: 'E',
	FABRIKA_SERVICE_KEY: 'S',
}

export type ManagedValues = Record<ManagedKey, string | null>
export type ConfirmedManagedEntry = { state: 'absent' } | { state: 'confirmed'; referenceName: string; backingRecordId: string }
export type ManagedEntry = ConfirmedManagedEntry | { state: 'pending'; referenceName: string }
export type ManagedBinding = Record<ManagedKey, ManagedEntry>
export type ConfirmedManagedBinding = Record<ManagedKey, ConfirmedManagedEntry>

export interface ManagedOwner {
	protocol: 1
	appId: string
	environment: string
	namespaceId: string
	projectId: string
	serviceId: string
	hostname: string
}

export interface ManagedMarker extends ManagedOwner {
	creationProcessId: string
	initialCodelessAppVersionId: string
}

interface ManagedCheckpointCoordinates extends ManagedOwner {
	runId: string
	appVersionId: string
	markerRecordId: string
	originalArtifactSha256: string
	descriptorSha256: string
	setup: string
	sourceCommitSha: string
}

export type ManagedCheckpoint =
	& ManagedCheckpointCoordinates
	& (
		| { phase: 'managed_env_staging'; binding: ManagedBinding }
		| { phase: 'managed_env_staged' | 'source_uploaded' | 'build_trigger_requested'; binding: ConfirmedManagedBinding }
		| { phase: 'build_triggered'; binding: ConfirmedManagedBinding; processId?: string }
	)

export function mapManagedKeys<T>(read: (key: ManagedKey) => T): Record<ManagedKey, T> {
	return {
		FABRIKA_RELEASE: read('FABRIKA_RELEASE'),
		FABRIKA_OPERATIONS_DSN: read('FABRIKA_OPERATIONS_DSN'),
		FABRIKA_IAM_ISSUER: read('FABRIKA_IAM_ISSUER'),
		FABRIKA_APP_ID: read('FABRIKA_APP_ID'),
		FABRIKA_ENVIRONMENT: read('FABRIKA_ENVIRONMENT'),
		FABRIKA_SERVICE_KEY: read('FABRIKA_SERVICE_KEY'),
	}
}

const invalid = (): never => {
	throw new Error('zerops: invalid managed-environment protocol data')
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const record = (value: unknown): Record<string, unknown> => {
	if (!isRecord(value)) return invalid()
	const prototype: unknown = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return invalid()
	return value
}

const exactFields = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void => {
	if (Reflect.ownKeys(value).length !== Object.keys(value).length) invalid()
	if (required.some((key) => !Object.hasOwn(value, key))) invalid()
	if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))) invalid()
}

const text = (value: unknown): string => {
	if (typeof value !== 'string' || value.trim() === '') return invalid()
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code < 32 || (code >= 127 && code <= 159)) return invalid()
	}
	return value
}

const digest = (value: unknown): string => {
	if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return invalid()
	return value
}

const ownerFields = ['protocol', 'appId', 'environment', 'namespaceId', 'projectId', 'serviceId', 'hostname']

const readOwner = (value: Record<string, unknown>): ManagedOwner => {
	if (value['protocol'] !== 1) return invalid()
	const hostname = text(value['hostname'])
	if (!/^[a-z0-9]{1,25}$/.test(hostname)) return invalid()
	return {
		protocol: 1,
		appId: text(value['appId']),
		environment: text(value['environment']),
		namespaceId: text(value['namespaceId']),
		projectId: text(value['projectId']),
		serviceId: text(value['serviceId']),
		hostname,
	}
}

const bounded = (value: unknown): void => {
	if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MANAGED_CHECKPOINT_MAX_BYTES) invalid()
}

export function parseManagedOwner(value: unknown): ManagedOwner {
	const raw = record(value)
	exactFields(raw, ownerFields)
	const owner = readOwner(raw)
	bounded(owner)
	return owner
}

export function serializeManagedOwner(value: ManagedOwner): string {
	return JSON.stringify(parseManagedOwner(value))
}

export function parseManagedMarker(contents: string): ManagedMarker {
	if (new TextEncoder().encode(contents).byteLength > MANAGED_CHECKPOINT_MAX_BYTES) return invalid()
	let raw: unknown
	try {
		raw = JSON.parse(contents)
	} catch {
		return invalid()
	}
	const value = record(raw)
	exactFields(value, [...ownerFields, 'creationProcessId', 'initialCodelessAppVersionId'])
	return {
		...readOwner(value),
		creationProcessId: text(value['creationProcessId']),
		initialCodelessAppVersionId: text(value['initialCodelessAppVersionId']),
	}
}

export function serializeManagedMarker(value: ManagedMarker): string {
	return JSON.stringify(parseManagedMarker(JSON.stringify(value)))
}

export function managedOwnerCoordinates(value: ManagedOwner): ManagedOwner {
	return parseManagedOwner({
		protocol: value.protocol,
		appId: value.appId,
		environment: value.environment,
		namespaceId: value.namespaceId,
		projectId: value.projectId,
		serviceId: value.serviceId,
		hostname: value.hostname,
	})
}

export function parseManagedValues(value: unknown): ManagedValues {
	const raw = record(value)
	exactFields(raw, MANAGED_KEYS)
	return mapManagedKeys((key) => {
		const entry = raw[key]
		if (entry !== null && typeof entry !== 'string') return invalid()
		return entry
	})
}

export function parseManagedBinding(value: unknown): ManagedBinding {
	const raw = record(value)
	exactFields(raw, MANAGED_KEYS)
	const names = new Set<string>()
	const ids = new Set<string>()
	return mapManagedKeys((key): ManagedEntry => {
		const entry = record(raw[key])
		if (entry['state'] === 'absent') {
			exactFields(entry, ['state'])
			return { state: 'absent' }
		}
		const state = entry['state']
		if (state !== 'pending' && state !== 'confirmed') return invalid()
		exactFields(entry, state === 'pending' ? ['state', 'referenceName'] : ['state', 'referenceName', 'backingRecordId'])
		const referenceName = text(entry['referenceName'])
		if (!/^FABRIKA_MENV_[a-f0-9]{48}_[RDIAES]$/.test(referenceName) || !referenceName.endsWith(`_${slots[key]}`)) return invalid()
		if (names.has(referenceName)) return invalid()
		names.add(referenceName)
		if (state === 'pending') return { state, referenceName }
		const backingRecordId = text(entry['backingRecordId'])
		if (ids.has(backingRecordId)) return invalid()
		ids.add(backingRecordId)
		return { state, referenceName, backingRecordId }
	})
}

export function requireConfirmedBinding(value: ManagedBinding): ConfirmedManagedBinding {
	const binding = parseManagedBinding(value)
	return mapManagedKeys((key) => {
		const entry = binding[key]
		if (entry.state === 'pending') return invalid()
		return entry
	})
}

/** This parser checks shape and slot grammar; verifyManagedCheckpoint also checks coordinate-derived names. */
export function parseManagedCheckpoint(value: unknown): ManagedCheckpoint {
	const raw = record(value)
	const phase = raw['phase']
	exactFields(raw, [
		...ownerFields,
		'runId',
		'appVersionId',
		'markerRecordId',
		'originalArtifactSha256',
		'descriptorSha256',
		'setup',
		'sourceCommitSha',
		'phase',
		'binding',
	], phase === 'build_triggered' ? ['processId'] : [])
	const sourceCommitSha = text(raw['sourceCommitSha'])
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommitSha)) return invalid()
	const coordinates: ManagedCheckpointCoordinates = {
		...readOwner(raw),
		runId: text(raw['runId']),
		appVersionId: text(raw['appVersionId']),
		markerRecordId: text(raw['markerRecordId']),
		originalArtifactSha256: digest(raw['originalArtifactSha256']),
		descriptorSha256: digest(raw['descriptorSha256']),
		setup: text(raw['setup']),
		sourceCommitSha,
	}
	const binding = parseManagedBinding(raw['binding'])
	if (
		MANAGED_KEYS.some((key) => {
			const entry = binding[key]
			return entry.state === 'confirmed' && entry.backingRecordId === coordinates.markerRecordId
		})
	) return invalid()
	bounded(raw)
	if (phase === 'managed_env_staging') return { ...coordinates, phase, binding }
	const confirmed = requireConfirmedBinding(binding)
	if (phase === 'managed_env_staged' || phase === 'source_uploaded' || phase === 'build_trigger_requested') {
		return { ...coordinates, phase, binding: confirmed }
	}
	if (phase !== 'build_triggered') return invalid()
	return { ...coordinates, phase, binding: confirmed, ...(Object.hasOwn(raw, 'processId') ? { processId: text(raw['processId']) } : {}) }
}

export function encodeManagedCheckpoint(value: ManagedCheckpoint): JsonValue {
	const checkpoint = parseManagedCheckpoint(value)
	return { ...checkpoint, binding: mapManagedKeys((key) => ({ ...checkpoint.binding[key] })) }
}

export async function managedReferenceNames(
	coordinates: { projectId: string; serviceId: string; appVersionId: string },
): Promise<Record<ManagedKey, string>> {
	const tuple = [1, text(coordinates.projectId), text(coordinates.serviceId), text(coordinates.appVersionId)]
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(tuple))))
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 48)
	return mapManagedKeys((key) => `${MANAGED_ENVIRONMENT_PREFIX}${hex}_${slots[key]}`)
}

export async function createPendingBinding(
	coordinates: { projectId: string; serviceId: string; appVersionId: string },
	input: ManagedValues,
): Promise<ManagedBinding> {
	const values = parseManagedValues(input)
	const names = await managedReferenceNames(coordinates)
	return mapManagedKeys((key) => values[key] === null ? { state: 'absent' } : { state: 'pending', referenceName: names[key] })
}

export async function verifyManagedCheckpoint(value: unknown): Promise<ManagedCheckpoint> {
	const checkpoint = parseManagedCheckpoint(value)
	const names = await managedReferenceNames(checkpoint)
	for (const key of MANAGED_KEYS) {
		const entry = checkpoint.binding[key]
		if (entry.state !== 'absent' && entry.referenceName !== names[key]) return invalid()
	}
	return checkpoint
}
