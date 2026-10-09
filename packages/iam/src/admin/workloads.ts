import { API_KEY_PREFIX } from '@fabrika/auth-core'
import type { IssueWorkloadKeyRequest, IssueWorkloadKeyResponse, RevokeWorkloadKeysRequest, RevokeWorkloadKeysResponse } from '@fabrika/iam-contract'
import { principalStatus } from '../db'
import { keyExpiryProblem } from '../issue'
import { unixNow } from '../repositories/sql'
import { generateToken, hashToken } from '../secret'
import { adminAudit, type AdminContext, fail } from './context'

/** A job or a webhook name of a contract, as `buildArtifact` admits it. */
const WORKLOAD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
/** An `app` workload is the consuming application of an export, named by its id. */
const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Issue a fresh key for one workload (ADR-0022 "Principal kinds"): a job, a webhook, or the connector of an application
 * that consumes this application's exports. The principal is created on first use; what the key
 * may do is the app's reconciled declaration of the workload, never part of this request. The key the caller recorded
 * as active (`keep`) stays valid, so the version still running keeps working until the caller has recorded the new one;
 * every other key of the workload is an orphan of an attempt whose record failed, and is revoked.
 */
export async function issueWorkloadKeyUseCase(c: AdminContext, input: IssueWorkloadKeyRequest): Promise<IssueWorkloadKeyResponse> {
	if (input.kind === 'app' ? !APP_ID.test(input.name) : !WORKLOAD_NAME.test(input.name)) {
		return fail(
			400,
			input.kind === 'app'
				? 'an app workload is named by the consuming application id'
				: 'a workload name is a contract name (a letter, then letters, digits or _, at most 64)',
		)
	}
	const expiryProblem = keyExpiryProblem(input.expiresAt, unixNow())
	if (expiryProblem !== null) {
		return fail(400, expiryProblem)
	}
	const principal = await c.services.repositories.workloads.ensurePrincipal(input.app, input.kind, input.name)
	if (principalStatus(principal) === 'disabled') {
		return fail(409, 'the workload principal is disabled')
	}
	const previous = (await c.services.repositories.credentials.listCredentialsForPrincipal(principal.id)).filter((row) => row.revoked_at === null)
	const key = `${API_KEY_PREFIX}${generateToken()}`
	const credentialId = await c.services.repositories.credentials.createCredential({
		tokenHash: await hashToken(key),
		label: principal.label,
		principalId: principal.id,
		app: input.app,
		issuedBy: c.admin.id,
		expiresAt: input.expiresAt,
		grants: [],
	})
	const orphans = previous.filter((row) => row.id !== input.keep)
	for (const orphan of orphans) {
		await c.services.repositories.credentials.revokeCredential(orphan.id)
	}
	await adminAudit(c, {
		action: 'iam.workload.key.issue',
		resourceType: 'principal',
		resourceId: principal.id,
		metadata: { app: input.app, kind: input.kind, name: input.name, expiresAt: input.expiresAt, kept: input.keep, revoked: orphans.length },
	})
	return { key, credentialId, principalId: principal.id, expiresAt: input.expiresAt }
}

/** Revoke every live key of one workload, so a consumer that stopped importing keeps no key at the owner. */
export async function revokeWorkloadKeysUseCase(c: AdminContext, input: RevokeWorkloadKeysRequest): Promise<RevokeWorkloadKeysResponse> {
	const principalId = await c.services.repositories.workloads.findPrincipalId(input.app, input.kind, input.name)
	if (principalId === null) {
		return { revoked: 0 }
	}
	const live = (await c.services.repositories.credentials.listCredentialsForPrincipal(principalId)).filter((row) => row.revoked_at === null)
	for (const row of live) {
		await c.services.repositories.credentials.revokeCredential(row.id)
	}
	await adminAudit(c, {
		action: 'iam.workload.key.revoke',
		resourceType: 'principal',
		resourceId: principalId,
		metadata: { app: input.app, kind: input.kind, name: input.name, revoked: live.length },
	})
	return { revoked: live.length }
}
