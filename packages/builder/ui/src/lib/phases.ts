import type { PhaseId } from '../../../shared/phases'

export type PhaseStatus = 'done' | 'current' | 'upcoming'

export function statusOf(id: PhaseId, completed: PhaseId[], current: PhaseId): PhaseStatus {
	if (completed.includes(id)) return 'done'
	if (id === current) return 'current'
	return 'upcoming'
}
