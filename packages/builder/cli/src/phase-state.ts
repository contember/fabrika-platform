import { type Approvals, readApprovals, writeApprovals } from '../../shared/approvals'
import { derivePhase, offlineGateProbe, phaseInputs, type PhaseState } from '../../shared/derive'
import { phaseById, type PhaseId } from '../../shared/phases'
import { fetchPhase } from './daemon-client'

export interface ResolvedPhase {
	state: PhaseState
	source: 'daemon' | 'offline'
}

export async function resolvePhaseState(
	repoRoot: string,
	fabrikaDir: string,
	sessionId?: string,
): Promise<ResolvedPhase> {
	const fromDaemon = await fetchPhase(fabrikaDir, sessionId)
	if (fromDaemon) {
		adoptApprovals(repoRoot, fromDaemon.completed)
		return { state: fromDaemon, source: 'daemon' }
	}
	return { state: derivePhase(repoRoot, offlineGateProbe), source: 'offline' }
}

/**
 * A project initialized before approvals existed records the gated phases the daemon judged reviewed, over their files
 * now. Without the daemon it then derives the same phase, instead of refusing gates that were reviewed.
 */
function adoptApprovals(repoRoot: string, completed: readonly PhaseId[]): void {
	if (readApprovals(repoRoot) !== null) return
	const at = new Date().toISOString()
	const approvals: Approvals = {}
	for (const id of completed) {
		const phase = phaseById(id)
		if (phase.gate) approvals[id] = { at, inputs: phaseInputs(repoRoot, phase) }
	}
	writeApprovals(repoRoot, approvals)
}
