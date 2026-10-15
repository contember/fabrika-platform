import type { Confirmations } from '@fabrika/installation-init'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import type { Sleeper, ZeropsApi } from '../index'
import type { CheckerPublication } from './checker-release'
import type { PlatformSourcePreparer } from './installation-source'
import type { InitLog } from './log'
import type { PlatformUploadFetch } from './platform-upload'

/** The one question this command asks. Injected so the flow can be exercised without a TTY. */
export type InstallPrompts = Confirmations

/** Everything `runInstall` reaches the outside world through. */
export interface InstallCollaborators {
	readonly prepareSource: PlatformSourcePreparer
	readonly checkerPublished: CheckerPublication
	readonly uploadFetch: PlatformUploadFetch
	readonly api: ZeropsApi
	readonly reconcileSchema: SchemaReconciler
	readonly sleep: Sleeper
	readonly log: InitLog
	readonly prompts: InstallPrompts
	readonly signal: AbortSignal
	/** Create the local secrets file (`--secrets-file`) with this text. Never logged. */
	readonly storeSecrets: (text: string) => Promise<void>
}

export const assertRunning = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new Error('the Zerops platform install was cancelled')
	}
}
