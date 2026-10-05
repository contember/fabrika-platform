import { z } from 'zod'
import { MANAGED_KEYS, type ManagedKey } from '../../../provider-zerops/src/managed-environment/protocol'
import type { EmulatorSnapshot, ServiceRecord } from './model'
import { id } from './protocol'

export const managedRuntimeReferenceSchema = z.object({
	key: z.string().refine((key): key is ManagedKey => MANAGED_KEYS.some((managed) => managed === key)),
	content: z.string().regex(/^\$\{FABRIKA_MENV_[a-f0-9]{48}_[RDIAES]\}$/),
}).strict()

export const managedRuntimeReferencesSchema = z.array(managedRuntimeReferenceSchema).max(MANAGED_KEYS.length).refine(
	(references) => new Set(references.map((reference) => reference.key)).size === references.length,
)

export type ManagedRuntimeReference = z.infer<typeof managedRuntimeReferenceSchema>

export function readManagedRuntimeReferences(env: Record<string, unknown> | undefined): ManagedRuntimeReference[] {
	return MANAGED_KEYS.flatMap((key) => {
		const content = env?.[key]
		return content === undefined ? [] : [managedRuntimeReferenceSchema.parse({ key, content })]
	})
}

export function activateManagedRuntimeReferences(
	state: EmulatorSnapshot,
	service: ServiceRecord,
	references: readonly ManagedRuntimeReference[],
): void {
	state.serviceEnv = state.serviceEnv.filter((record) => record.serviceStackId !== service.id || !MANAGED_KEYS.some((key) => key === record.key))
	for (const reference of references) {
		state.serviceEnv.push({
			id: id('env', state.nextEnv++),
			serviceStackId: service.id,
			key: reference.key,
			content: reference.content,
			type: 'USER',
			sensitive: false,
		})
	}
}
