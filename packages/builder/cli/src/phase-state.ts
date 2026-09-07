import { fetchPhase } from './daemon-client'
import { derivePhase, offlineGateProbe, type PhaseState } from './derive'

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
		return { state: fromDaemon, source: 'daemon' }
	}
	return { state: derivePhase(repoRoot, offlineGateProbe), source: 'offline' }
}
