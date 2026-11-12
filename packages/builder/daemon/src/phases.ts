import { dirname } from 'path'
import { derivePhase, type GateReview, offlineGateProbe, type PhaseState as SharedPhaseState } from '../../shared/derive'
import type { PhaseId } from '../../shared/phases'

export interface PhaseState extends SharedPhaseState {
	gateName?: string
}

export interface GateOracle {
	gateReview(sessionId: string, gateName: PhaseId): GateReview
}

export function derivePhaseState(
	fabrikaDir: string,
	sessionId = '',
	oracle?: GateOracle,
): PhaseState {
	const state = derivePhase(dirname(fabrikaDir), oracle ? (phase) => oracle.gateReview(sessionId, phase.id) : offlineGateProbe)
	return state.gate ? { ...state, gateName: state.current } : state
}
