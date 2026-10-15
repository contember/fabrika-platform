import type { AuthContext } from '@fabrika/auth'
import type { ConsoleAccessDto, ConsoleScopedActionsDto } from '@fabrika/control-contract'
import { CONTROL_SCOPES } from '@fabrika/control-contract'
import { controlSchema } from '../fabrika.schema'

const CONSOLE_ACTIONS: readonly string[] = controlSchema.actions.map((declared) => declared.action)

/**
 * What the caller holds of the console's vocabulary, read through `can` and `scopedTo` only, so the bootstrap admin
 * reads as holding every action. Authorization information for the console's navigation, not a decision.
 */
export function consoleAccess(auth: AuthContext): ConsoleAccessDto {
	const global: string[] = []
	const scoped = new Map<string, { type: string; value: string; actions: string[] }>()
	for (const action of CONSOLE_ACTIONS) {
		if (auth.can(action)) {
			global.push(action)
			continue
		}
		for (const dimension of Object.values(CONTROL_SCOPES)) {
			for (const value of auth.scopedTo(action, dimension) ?? []) {
				const key = JSON.stringify([dimension, value])
				const entry = scoped.get(key) ?? { type: dimension, value, actions: [] }
				entry.actions.push(action)
				scoped.set(key, entry)
			}
		}
	}
	const scopes: ConsoleScopedActionsDto[] = [...scoped.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, entry]) => entry)
	const principal = auth.principal === null ? null : { id: auth.principal.id, label: auth.principal.label }
	return { principal, global, scopes }
}
