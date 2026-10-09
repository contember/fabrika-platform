import { API_KEY_PREFIX } from '@fabrika/auth-core'
import type { IssueWorkloadKeyRequest, IssueWorkloadKeyResponse } from '@fabrika/iam-contract'
import { principalStatus } from '../db'
import { keyExpiryProblem } from '../issue'
import { unixNow } from '../repositories/sql'
import { generateToken, hashToken } from '../secret'
import { adminAudit, type AdminContext, fail } from './context'

/** A job or a webhook name of a contract, as `buildArtifact` admits it. */
const WORKLOAD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * Issue a fresh key for one workload (ADR-0022 "Principal kinds"). The principal is created on first use; what the key
 * may do is the app's reconciled declaration of the workload, never part of this request. The newest older key stays
 * valid, so the version still running keeps working while the deploy that carries the new key rolls out; every older
 * one is revoked.
 */
export async function issueWorkloadKeyUseCase(c: AdminContext, input: IssueWorkloadKeyRequest): Promise<IssueWorkloadKeyResponse> {
	if (!WORKLOAD_NAME.test(input.name)) {
		return fail(400, 'a workload name is a contract name (a letter, then letters, digits or _, at most 64)')
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
	for (const stale of previous.slice(1)) {
		await c.services.repositories.credentials.revokeCredential(stale.id)
	}
	await adminAudit(c, {
		action: 'iam.workload.key.issue',
		resourceType: 'principal',
		resourceId: principal.id,
		metadata: { app: input.app, kind: input.kind, name: input.name, expiresAt: input.expiresAt, revoked: Math.max(previous.length - 1, 0) },
	})
	return { key, credentialId, principalId: principal.id, expiresAt: input.expiresAt }
}
