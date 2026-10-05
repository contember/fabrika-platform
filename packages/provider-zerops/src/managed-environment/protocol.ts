import type { JsonValue } from '@fabrika/provider-contract'
import { z } from 'zod'

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
// Check the raw object before Zod copies it, so hidden fields and custom prototypes cannot disappear.
const protocolObjectSchema = z.unknown().superRefine((value, ctx) => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		ctx.addIssue({ code: 'custom', message: 'invalid protocol object', fatal: true })
		return
	}
	const prototype: unknown = Object.getPrototypeOf(value)
	if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== Object.keys(value).length) {
		ctx.addIssue({ code: 'custom', message: 'invalid protocol object', fatal: true })
	}
})
const textSchema = z.string().refine((value) => value.trim() !== '' && !/\p{Cc}/u.test(value))
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const referenceCoordinatesSchema = z.object({ projectId: textSchema, serviceId: textSchema, appVersionId: textSchema })
const ownerSchema = z.object({
	protocol: z.literal(1),
	appId: textSchema,
	environment: textSchema,
	namespaceId: textSchema,
	projectId: textSchema,
	serviceId: textSchema,
	hostname: z.string().regex(/^[a-z0-9]{1,25}$/),
}).strict()
const managedOwnerSchema = protocolObjectSchema.pipe(ownerSchema)
const markerSchema = protocolObjectSchema.pipe(ownerSchema.extend({
	creationProcessId: textSchema,
	initialCodelessAppVersionId: textSchema,
}))
const managedValuesSchema = protocolObjectSchema.pipe(z.object(mapManagedKeys(() => z.string().nullable())).strict())
const managedEntrySchema = protocolObjectSchema.pipe(z.discriminatedUnion('state', [
	z.object({ state: z.literal('absent') }).strict(),
	z.object({ state: z.literal('pending'), referenceName: textSchema }).strict(),
	z.object({ state: z.literal('confirmed'), referenceName: textSchema, backingRecordId: textSchema }).strict(),
]))
const managedBindingSchema = protocolObjectSchema.pipe(z.object(mapManagedKeys(() => managedEntrySchema)).strict()).superRefine((binding, ctx) => {
	const names = new Set<string>()
	const ids = new Set<string>()
	for (const key of MANAGED_KEYS) {
		const entry = binding[key]
		if (entry.state === 'absent') continue
		if (
			!/^FABRIKA_MENV_[a-f0-9]{48}_[RDIAES]$/.test(entry.referenceName) || !entry.referenceName.endsWith(`_${slots[key]}`)
			|| names.has(entry.referenceName)
		) {
			ctx.addIssue({ code: 'custom', message: 'invalid managed reference' })
		}
		names.add(entry.referenceName)
		if (entry.state !== 'confirmed') continue
		if (ids.has(entry.backingRecordId)) ctx.addIssue({ code: 'custom', message: 'duplicate managed record' })
		ids.add(entry.backingRecordId)
	}
})
const checkpointSchema = protocolObjectSchema.pipe(ownerSchema.extend({
	runId: textSchema,
	appVersionId: textSchema,
	markerRecordId: textSchema,
	originalArtifactSha256: digestSchema,
	descriptorSha256: digestSchema,
	setup: textSchema,
	sourceCommitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
	phase: z.enum(['managed_env_staging', 'managed_env_staged', 'source_uploaded', 'build_trigger_requested', 'build_triggered']),
	binding: managedBindingSchema,
	processId: textSchema.optional(),
})).superRefine((value, ctx) => {
	if (Object.hasOwn(value, 'processId') && (value.phase !== 'build_triggered' || value.processId === undefined)) {
		ctx.addIssue({ code: 'custom', message: 'invalid process field' })
	}
})

const bounded = (value: unknown): void => {
	if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MANAGED_CHECKPOINT_MAX_BYTES) invalid()
}

export function parseManagedOwner(value: unknown): ManagedOwner {
	const result = managedOwnerSchema.safeParse(value)
	if (!result.success) return invalid()
	const owner = result.data
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
	const result = markerSchema.safeParse(raw)
	return result.success ? result.data : invalid()
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
	const result = managedValuesSchema.safeParse(value)
	return result.success ? result.data : invalid()
}

export function parseManagedBinding(value: unknown): ManagedBinding {
	const result = managedBindingSchema.safeParse(value)
	return result.success ? result.data : invalid()
}

function confirmedBinding(binding: ManagedBinding): ConfirmedManagedBinding {
	return mapManagedKeys((key) => {
		const entry = binding[key]
		if (entry.state === 'pending') return invalid()
		return entry
	})
}

export function requireConfirmedBinding(value: ManagedBinding): ConfirmedManagedBinding {
	return confirmedBinding(parseManagedBinding(value))
}

/** This parser checks shape and slot grammar; verifyManagedCheckpoint also checks coordinate-derived names. */
export function parseManagedCheckpoint(value: unknown): ManagedCheckpoint {
	const result = checkpointSchema.safeParse(value)
	if (!result.success) return invalid()
	const { phase, binding, processId, ...coordinates } = result.data
	if (
		MANAGED_KEYS.some((key) => {
			const entry = binding[key]
			return entry.state === 'confirmed' && entry.backingRecordId === coordinates.markerRecordId
		})
	) return invalid()
	bounded(value)
	if (phase === 'managed_env_staging') return { ...coordinates, phase, binding }
	const confirmed = confirmedBinding(binding)
	if (phase === 'managed_env_staged' || phase === 'source_uploaded' || phase === 'build_trigger_requested') {
		return { ...coordinates, phase, binding: confirmed }
	}
	if (phase !== 'build_triggered') return invalid()
	return { ...coordinates, phase, binding: confirmed, ...(processId === undefined ? {} : { processId }) }
}

export function encodeManagedCheckpoint(value: ManagedCheckpoint): JsonValue {
	const checkpoint = parseManagedCheckpoint(value)
	return { ...checkpoint, binding: mapManagedKeys((key) => ({ ...checkpoint.binding[key] })) }
}

export async function managedReferenceNames(
	coordinates: { projectId: string; serviceId: string; appVersionId: string },
): Promise<Record<ManagedKey, string>> {
	const result = referenceCoordinatesSchema.safeParse(coordinates)
	if (!result.success) return invalid()
	const tuple = [1, result.data.projectId, result.data.serviceId, result.data.appVersionId]
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
