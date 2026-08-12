import type { ZeropsSourceErrorCode, ZeropsSourceErrorStage } from '@fabrika/provider-zerops'

export class SourceFailure extends Error {
	constructor(
		readonly code: ZeropsSourceErrorCode,
		readonly stage: ZeropsSourceErrorStage,
		readonly retryable: boolean,
		readonly status: number,
	) {
		super('source operation failed')
		this.name = 'SourceFailure'
	}
}

export function cancelled(stage: ZeropsSourceErrorStage): SourceFailure {
	return new SourceFailure('cancelled', stage, false, 409)
}

export function throwIfAborted(
	signal: AbortSignal,
	stage: ZeropsSourceErrorStage,
): void {
	if (signal.aborted) throw cancelled(stage)
}
