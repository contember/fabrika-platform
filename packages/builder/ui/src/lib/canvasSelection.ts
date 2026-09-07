import type { CanvasFileInfo, RevisionMeta } from './types'

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
