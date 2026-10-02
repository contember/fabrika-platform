import { parseServiceEnvResponse } from '../api/service-env-response'
import type { ZeropsApi, ZeropsServiceEnv } from '../api/types'
import type { Sleeper } from '../collaborators'
import type { CodelessManagedServiceEvidence } from './admission'
import { MANAGED_ENVIRONMENT_MARKER, MANAGED_KEYS, type ManagedOwner, parseManagedOwner, serializeManagedMarker } from './protocol'

export interface ManagedCreateOnlyInput {
	api: Pick<ZeropsApi, 'createServiceEnv' | 'listServiceEnv'>
	serviceId: string
	key: string
	value: string
	/** A known record identity may be rechecked, but never replaced by a matching-content record. */
	expectedRecordId?: string
	signal: AbortSignal
	sleep: Sleeper
	attempts?: number
	intervalMs?: number
}

const failed = (): never => {
	throw new Error('zerops: managed-environment create-only confirmation failed')
}

/** A lost response is confirmable only while the original intended value remains in this invocation. */
async function createAndConfirmManagedRecord(input: ManagedCreateOnlyInput): Promise<{ referenceName: string; backingRecordId: string }> {
	const attempts = input.attempts ?? 5
	const intervalMs = input.intervalMs ?? 1000
	if (!Number.isInteger(attempts) || attempts < 1 || attempts > 30 || !Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 10_000) {
		return failed()
	}
	if (input.serviceId.trim() === '' || (input.expectedRecordId !== undefined && input.expectedRecordId.trim() === '')) return failed()
	if (input.key !== MANAGED_ENVIRONMENT_MARKER && !/^FABRIKA_MENV_[a-f0-9]{48}_[RDIAES]$/.test(input.key)) return failed()
	input.signal.throwIfAborted()
	try {
		await input.api.createServiceEnv({ serviceId: input.serviceId, key: input.key, value: input.value, signal: input.signal })
	} catch {
		input.signal.throwIfAborted()
	}
	for (let attempt = 0; attempt < attempts; attempt++) {
		input.signal.throwIfAborted()
		let listed: ZeropsServiceEnv[] | undefined
		try {
			listed = await input.api.listServiceEnv({ serviceId: input.serviceId, signal: input.signal })
		} catch {
			input.signal.throwIfAborted()
		}
		input.signal.throwIfAborted()
		if (listed !== undefined) {
			const records = parseServiceEnvResponse({ items: listed }, input.serviceId)
			const found = records.find((entry) => entry.key === input.key)
			if (found !== undefined) {
				if (found.sensitive !== true || found.content !== input.value || (input.expectedRecordId !== undefined && found.id !== input.expectedRecordId)) {
					return failed()
				}
				return { referenceName: input.key, backingRecordId: found.id }
			}
		}
		if (attempt + 1 < attempts) {
			try {
				await input.sleep(intervalMs, input.signal)
			} catch {
				input.signal.throwIfAborted()
				return failed()
			}
		}
	}
	return failed()
}

export async function createManagedRecord(input: ManagedCreateOnlyInput): Promise<{ referenceName: string; backingRecordId: string }> {
	if (!/^FABRIKA_MENV_[a-f0-9]{48}_[RDIAES]$/.test(input.key)) return failed()
	return createAndConfirmManagedRecord(input)
}

export async function createManagedMarker(
	input: Omit<ManagedCreateOnlyInput, 'serviceId' | 'key' | 'value'> & {
		owner: ManagedOwner
		creation: CodelessManagedServiceEvidence
	},
): Promise<{ markerRecordId: string }> {
	const owner = parseManagedOwner(input.owner)
	const creation = input.creation
	if (
		creation.serviceId !== owner.serviceId || creation.projectId !== owner.projectId || creation.hostname !== owner.hostname
		|| creation.creationProcessId.trim() === ''
	) return failed()
	const markerContents = serializeManagedMarker({
		...owner,
		creationProcessId: creation.creationProcessId,
		initialCodelessAppVersionId: creation.codelessAppVersionId,
	})
	input.signal.throwIfAborted()
	let observed: ZeropsServiceEnv[]
	try {
		observed = await input.api.listServiceEnv({ serviceId: owner.serviceId, signal: input.signal })
	} catch {
		input.signal.throwIfAborted()
		return failed()
	}
	input.signal.throwIfAborted()
	const records = parseServiceEnvResponse({ items: observed }, owner.serviceId)
	if (records.some((entry) => MANAGED_KEYS.some((key) => key === entry.key))) return failed()
	const confirmed = await createAndConfirmManagedRecord({
		...input,
		serviceId: owner.serviceId,
		key: MANAGED_ENVIRONMENT_MARKER,
		value: markerContents,
	})
	return { markerRecordId: confirmed.backingRecordId }
}
