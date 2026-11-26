// IAM's mirror of each environment's approval gates (ADR-0083 §4, §8), outside a protection change, which writes IAM
// itself, the stricter side first. A new environment's gates reach IAM before its row; the maintenance pass writes every
// environment IAM has not taken at its current protection revision: each one after an upgrade to the mirror (IAM reads a
// missing `credentials` as `person` until then), a new environment whose write failed, and a change whose last write to
// IAM failed.

import { RpcError } from '@fabrika/app'
import { appEnvironmentId } from '@fabrika/auth-core'
import { fail } from '../api/domain'
import type { ControlRepositories } from '../db'
import type { GrantApprovalPort, IamGatesHeld } from './api'
import { iamGatesOf, looserCredentials } from './categories'

/**
 * Write a new environment's gates to IAM, as it starts (`getStartingProtection`), before its row exists: until IAM knows
 * an environment, a key that acts in every environment of its application does not count it. One that starts protected
 * is not created when IAM does not take them, or answers a looser `credentials` mode it holds (503), a later revision
 * kept; an older IAM, which answers no mode, is not compared. One that does not start protected is created, and the
 * maintenance pass writes them later.
 * Without the provisioning key there is nothing to write, and IAM reads every environment it knows as `person`.
 */
export async function writeNewEnvironmentGates(
	deps: { readonly repositories: Pick<ControlRepositories, 'registry'>; readonly grantApproval?: GrantApprovalPort },
	appId: string,
	env: string,
): Promise<void> {
	const port = deps.grantApproval
	if (port === undefined) return
	const start = await deps.repositories.registry.getStartingProtection(appId, env)
	const sent = iamGatesOf(start)
	let held: IamGatesHeld
	try {
		held = await port.set(appEnvironmentId(appId, env), sent, start.protection_revision)
	} catch {
		if (start.protected === 1) {
			fail(503, `IAM did not take the approval settings of \`${env}\`, which starts protected, so nothing was created; try again`)
		}
		console.warn("IAM did not take a new environment's approval gates; the maintenance pass writes them")
		return
	}
	// IAM keeps a later revision it already holds; a looser mode there would leave the new environment unguarded in IAM.
	// An older IAM answers no mode and holds none, reading every environment as `person`: nothing to compare.
	if (start.protected === 1 && held.credentials !== null && looserCredentials(held.credentials, sent.credentials)) {
		const which = held.revision > start.protection_revision ? 'a later revision of the approval settings' : 'the approval settings'
		fail(503, `IAM holds ${which} of \`${env}\`, which starts protected, with a looser \`credentials\` mode, so nothing was created`)
	}
}

/** The most environments one pass writes; the next pass continues. */
const PASS_LIMIT = 200

export interface IamMirrorSummary {
	readonly written: number
	readonly failed: number
}

/**
 * Write the gates of every environment IAM has not taken at its protection revision, then record that revision once IAM
 * answers it holds that revision and that mode. The write carries the revision as a protection change's does, so the pass
 * needs no lease: a change in flight has already written IAM at the next revision, which this older write cannot undo.
 * A refused write, and one IAM answers otherwise (it holds a later revision), is written again on the next pass; a
 * failure that is not IAM's refusal (IAM unreachable) ends the pass. One pass writes at most `PASS_LIMIT` environments.
 */
export async function convergeIamGates(
	deps: { readonly repositories: Pick<ControlRepositories, 'registry'>; readonly grantApproval?: GrantApprovalPort },
): Promise<IamMirrorSummary> {
	const port = deps.grantApproval
	if (port === undefined) return { written: 0, failed: 0 }
	const { registry } = deps.repositories
	let written = 0
	let failed = 0
	for (const row of await registry.listAppEnvsUnmirroredInIam(PASS_LIMIT)) {
		const gates = iamGatesOf(row)
		try {
			const held = await port.set(appEnvironmentId(row.app_id, row.env), gates, row.protection_revision)
			if (held.revision !== row.protection_revision || held.credentials !== gates.credentials) {
				failed += 1
				continue
			}
		} catch (cause) {
			failed += 1
			if (cause instanceof RpcError && cause.httpStatus !== undefined && cause.httpStatus >= 400 && cause.httpStatus < 500) continue
			break
		}
		await registry.markMirroredInIam(row.app_id, row.env, row.protection_revision)
		written += 1
	}
	return { written, failed }
}
