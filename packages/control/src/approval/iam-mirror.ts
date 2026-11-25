// The maintenance pass's half of IAM's mirror of each environment's approval gates (ADR-0083 §4, §8). A protection
// change writes IAM itself, the stricter side first; this pass writes every environment IAM has not taken at its current
// protection revision: each one after an upgrade to the mirror (IAM reads a missing `credentials` as `person` until
// then), a new environment, and a change whose last write to IAM failed.

import { RpcError } from '@fabrika/app'
import { appEnvironmentId } from '@fabrika/auth-core'
import type { ControlRepositories } from '../db'
import type { GrantApprovalPort } from './api'
import { iamGatesOf } from './categories'

/** The most environments one pass writes; the next pass continues. */
const PASS_LIMIT = 200

export interface IamMirrorSummary {
	readonly written: number
	readonly failed: number
}

/**
 * Write the gates of every environment IAM has not taken at its protection revision, then record that revision. The
 * write carries the revision as a protection change's does, so the pass needs no lease: a change in flight has already
 * written IAM at the next revision, which this older write cannot undo. A refused write is written again on the next
 * pass; a failure that is not IAM's refusal (IAM unreachable) ends the pass.
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
		try {
			await port.set(appEnvironmentId(row.app_id, row.env), iamGatesOf(row), row.protection_revision)
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
