export type SourceFailureCode =
	| 'invalid_request'
	| 'installation_not_found'
	| 'ref_not_found'
	| 'commit_mismatch'
	| 'descriptor_missing'
	| 'descriptor_mismatch'
	| 'archive_rejected'
	| 'upload_rejected'
	| 'upload_failed'
	| 'credentials_invalid'
	| 'cancelled'
	| 'internal'

export type SourceFailureStage = 'resolve' | 'archive' | 'upload' | 'credentials'

/** A source failure names its stage and class only; upstream text and URLs can carry credentials. */
export class SourceFailure extends Error {
	constructor(
		readonly code: SourceFailureCode,
		readonly stage: SourceFailureStage,
	) {
		super(`source ${stage} failed (${code})`)
		this.name = 'SourceFailure'
	}
}

export function cancelled(stage: SourceFailureStage): SourceFailure {
	return new SourceFailure('cancelled', stage)
}

export function throwIfAborted(signal: AbortSignal, stage: SourceFailureStage): void {
	if (signal.aborted) throw cancelled(stage)
}
