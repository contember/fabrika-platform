import type { EmulatorSnapshot, ServiceRecord } from './model'
import { id } from './protocol'

/**
 * Replace a service's `type: ENV` records with the activated version's literal `run.envVariables`. ENV
 * records follow the version that runs (ADR-0044), are absent from `/env`, and collide with a user-data
 * write of the same key.
 */
export function activateRunEnvironment(state: EmulatorSnapshot, service: ServiceRecord, variables: Readonly<Record<string, string>>): void {
	state.serviceEnv = state.serviceEnv.filter((record) => record.serviceStackId !== service.id || record.type !== 'ENV')
	for (const [key, content] of Object.entries(variables)) {
		state.serviceEnv.push({ id: id('env', state.nextEnv++), serviceStackId: service.id, key, content, type: 'ENV', sensitive: false })
	}
}
