import {
	getApiKeyUseCase,
	listApiKeysUseCase,
	parseProvisionApiKeyRequest,
	provisionApiKeyUseCase,
	revokeApiKeyUseCase,
	rotateApiKeyUseCase,
} from './api-keys'
import { getAppSchemaUseCase, listAppsUseCase, listRolesUseCase, setReturnOriginsUseCase } from './app-schema'
import { listAuditUseCase, listAuthLogUseCase } from './audit'
import { type AdminContext } from './context'
import { createGrantUseCase, deleteGrantUseCase, updateGrantUseCase } from './grants'
import { json, readJson } from './http'
import { issueMembershipKeyUseCase } from './membership-keys'
import { disablePasswordUseCase, issuePasswordEnrollmentUseCase, issuePasswordResetUseCase } from './passwords'
import { createPolicyUseCase, deletePolicyUseCase, listPoliciesUseCase, updatePolicyUseCase } from './policies'
import { getPrincipalUseCase, invitePrincipalUseCase, listPrincipalsUseCase, me, promotePrincipalUseCase, updatePrincipalUseCase } from './principals'
import { listSessionsUseCase, revokeSessionsForPrincipalUseCase, revokeSessionUseCase } from './sessions'
import { createShareLinkUseCase, listShareLinksUseCase, revokeShareLinkUseCase } from './share-links'
import { issueWorkloadKeyUseCase, revokeWorkloadKeysUseCase } from './workloads'

/** Return the app's scopes, actions, and origin='app' roles (the reconciled vocabulary). */
export async function getAppSchema(c: AdminContext, app: string): Promise<Response> {
	return json(await adminUseCases.getAppSchema(c, { app }))
}

/**
 * Provision an API key: create a native service principal + grant and mint a `px_`
 * credential bound to it — resolved by the propustka-native path (`mintFromKey`), no
 * Cloudflare Access in front. The plaintext `px_` token is returned ONCE.
 *
 * There is no distributed transaction; the writes are local D1 (principal → grant →
 * credential). A failure partway leaves an orphan principal at worst — harmless (it
 * holds no live credential) and revocable from this page.
 */
export async function provisionApiKey(c: AdminContext): Promise<Response> {
	const body = await readJson(c.request)
	return json(await adminUseCases.provisionApiKey(c, parseProvisionApiKeyRequest(body)), { status: 201 })
}

/**
 * Revoke an API key: hard-delete its grants, soft-disable the service principal, and
 * revoke its `px_` credentials so they stop minting immediately. Revocation is
 * effective at once — `mintFromKey` re-resolves the credential on every mint.
 */
export async function revokeApiKey(c: AdminContext, principalId: string): Promise<Response> {
	return json(await adminUseCases.revokeApiKey(c, { principalId }))
}

/** The typed application operations. `/admin/rpc` serves all of them; REST serves four. */
export const adminUseCases = {
	me,
	listPrincipals: listPrincipalsUseCase,
	getPrincipal: getPrincipalUseCase,
	invitePrincipal: invitePrincipalUseCase,
	updatePrincipal: updatePrincipalUseCase,
	promotePrincipal: promotePrincipalUseCase,
	listSessions: listSessionsUseCase,
	revokeSession: revokeSessionUseCase,
	revokeSessionsForPrincipal: revokeSessionsForPrincipalUseCase,
	issuePasswordEnrollment: issuePasswordEnrollmentUseCase,
	issuePasswordReset: issuePasswordResetUseCase,
	disablePassword: disablePasswordUseCase,
	createGrant: createGrantUseCase,
	updateGrant: updateGrantUseCase,
	deleteGrant: deleteGrantUseCase,
	listApps: listAppsUseCase,
	listRoles: listRolesUseCase,
	getAppSchema: getAppSchemaUseCase,
	setReturnOrigins: setReturnOriginsUseCase,
	listPolicies: listPoliciesUseCase,
	createPolicy: createPolicyUseCase,
	updatePolicy: updatePolicyUseCase,
	deletePolicy: deletePolicyUseCase,
	listApiKeys: listApiKeysUseCase,
	getApiKey: getApiKeyUseCase,
	provisionApiKey: provisionApiKeyUseCase,
	rotateApiKey: rotateApiKeyUseCase,
	revokeApiKey: revokeApiKeyUseCase,
	listShareLinks: listShareLinksUseCase,
	createShareLink: createShareLinkUseCase,
	revokeShareLink: revokeShareLinkUseCase,
	listAudit: listAuditUseCase,
	listAuthLog: listAuthLogUseCase,
	issueWorkloadKey: issueWorkloadKeyUseCase,
	revokeWorkloadKeys: revokeWorkloadKeysUseCase,
	issueMembershipKey: issueMembershipKeyUseCase,
}

export { putAppSchema } from './app-schema'
export { type AdminContext, AdminUseCaseError } from './context'
