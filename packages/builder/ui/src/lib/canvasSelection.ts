import { PHASE_IDS } from '../../../shared/phases'
import type { CanvasFileInfo, PhaseId, RevisionMeta } from './types'

export function canvasFilesForRevision(
	revision: RevisionMeta | null,
): CanvasFileInfo[] {
	if (!revision) return []

	if (revision.canvasScope?.kind === 'view') {
		const filename = revision.canvasScope.filename
		return revision.canvasFiles.filter(
			(file) => file.filename === filename,
		)
	}

	if (revision.canvasScope?.kind === 'directory') {
		return revision.canvasFiles
	}

	const changed = revision.canvasFiles.filter(
		(file) =>
			!file.diffStats
			|| file.diffStats.added !== 0
			|| file.diffStats.removed !== 0,
	)
	return changed.length > 0 ? changed : revision.canvasFiles
}

const PHASE_LABELS: ReadonlySet<string> = new Set(PHASE_IDS)

/**
 * The latest revision a phase shows. The build hosts the gates opened inside it (the design checkpoint), whose labels
 * are not phase ids.
 */
export function revisionForPhase(revisions: readonly RevisionMeta[], phase: PhaseId): RevisionMeta | null {
	for (let i = revisions.length - 1; i >= 0; i--) {
		const label = revisions[i]?.label
		if (!label) continue
		if (label === phase || (phase === 'build' && !PHASE_LABELS.has(label))) return revisions[i] ?? null
	}
	return null
}
