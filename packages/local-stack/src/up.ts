import { registerLocalApps } from './app-registration'
import { compose, type ComposeOptions } from './compose'
import { ensureMachineKey } from './machine-key'
import { ensureNotesMembershipKey } from './membership-key'
import { prepareLocalStack } from './prepare'
import { ensureNotesWorkloadKeys } from './workload-keys'

/**
 * Start the composition. The platform comes first: IAM must know the apps, and Notes must hold its workload keys and
 * its membership transport, before the Notes container starts, because it refuses to start without them.
 */
export async function upLocalComposition(options: Pick<ComposeOptions, 'browser'> = {}): Promise<void> {
	await prepareLocalStack()
	await compose(['up', '--detach', '--wait', '--remove-orphans', 'platform-proxy'], options)
	await registerLocalApps()
	await ensureNotesWorkloadKeys()
	await ensureNotesMembershipKey()
	await compose(['up', '--detach', '--wait', '--remove-orphans'], options)
	await ensureMachineKey()
}
