import type { SchemaReconciler } from '@fabrika/provider-contract'
import type { Sleeper, ZeropsApi } from '@fabrika/provider-zerops'
import type { InitLog } from './log'

/** The one question this command asks. Injected so the flow can be exercised without a TTY. */
export interface InstallPrompts {
	confirm(question: string, defaultYes?: boolean): Promise<boolean>
}

/** Everything `runInstall` reaches the outside world through. */
export interface InstallCollaborators {
	readonly api: ZeropsApi
	readonly reconcileSchema: SchemaReconciler
	readonly sleep: Sleeper
	readonly log: InitLog
	readonly prompts: InstallPrompts
	readonly signal: AbortSignal
}

export const assertRunning = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new Error('the Zerops platform install was cancelled')
	}
}
