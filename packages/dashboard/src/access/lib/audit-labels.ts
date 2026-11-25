const ACTION_LABELS = new Map<string, string>([
	['iam.admin.access', 'Administration request'],
	['iam.principal.invite', 'Account created by an administrator'],
	['iam.principal.create', 'Account created'],
	['iam.principal.bootstrap', 'Bootstrap account created'],
	['iam.principal.claim', 'Organization identity linked'],
	['iam.principal.refresh', 'Identity updated from the organization'],
	['iam.principal.disable', 'Account disabled'],
	['iam.principal.enable', 'Account enabled'],
	['iam.principal.promote', 'Account made internal'],
	['iam.grant.create', 'Access added'],
	['iam.grant.update', 'Access updated'],
	['iam.grant.revoke', 'Access removed'],
	['iam.policy.create', 'Policy created'],
	['iam.policy.update', 'Policy updated'],
	['iam.policy.delete', 'Policy deleted'],
	['iam.apikey.create', 'API key issued'],
	['iam.apikey.rotate', 'API key rotated'],
	['iam.apikey.revoke', 'API key revoked'],
	['iam.credential.create', 'Credential issued'],
	['iam.credential.revoke', 'Credential revoked'],
	['iam.scope.create', 'Scope created'],
	['iam.member.assign', 'Membership assigned'],
	['iam.member.revoke', 'Membership removed'],
	['iam.member.invite', 'Invitation created'],
	['iam.member.reinvite', 'Invitation renewed'],
	['iam.member.uninvite', 'Invitation withdrawn'],
	['iam.member.accept', 'Invitation accepted'],
	['iam.link.issue', 'Sign-in link issued'],
	['iam.link.revoke', 'Sign-in link revoked'],
	['iam.password.enrollment.issue', 'Password setup link issued'],
	['iam.password.enrollment.complete', 'Password set'],
	['iam.password.enrollment.delivery_failed', 'Password setup email failed'],
	['iam.password.reset.issue', 'Password reset link issued'],
	['iam.password.reset.complete', 'Password reset completed'],
	['iam.password.reset.delivery_failed', 'Password reset email failed'],
	['iam.mail.relay_fallback', "Email sent past Control's mail relay"],
	['iam.password.disable', 'Password sign-in disabled'],
	['iam.password.rehash', 'Password hash upgraded'],
	['iam.second_factor.enrol', 'Two-step sign-in turned on'],
	['iam.second_factor.recovery_code.use', 'Recovery code used to sign in'],
	['iam.second_factor.throttle', 'Two-step sign-in blocked after wrong codes'],
	['iam.second_factor.reset', 'Two-step sign-in reset'],
	['iam.session.revoke', 'Browser session ended'],
	['iam.session.revoke_all', 'All browser sign-ins ended'],
	['iam.oauth.grant.create', 'Client authorized'],
	['iam.oauth.grant.revoke', 'Connected client disconnected'],
	['iam.app.schema.reconcile', 'Access schema reconciled'],
	['iam.app.return-origins.set', 'Return origins set'],
	['iam.workload.key.issue', 'Workload key issued'],
	['iam.workload.key.revoke', 'Workload key revoked'],
	['iam.membership-key.issue', 'Membership transport key issued'],
	['iam.brand.update', 'Installation branding updated'],
	['iam.external_app.put', 'External application saved'],
	['iam.external_app.delete', 'External application deleted'],
	['iam.oauth_client.put', 'Authoring client saved'],
	['iam.oauth_client.delete', 'Authoring client removed'],
	['iam.oauth_registry.import', 'OAuth client list imported'],
])

/** Why IAM revoked OAuth grants in bulk: a change to the client registry (ADR-0089). */
const REVOCATION_LABELS = new Map<string, string>([
	['client_removed', 'Sign-ins revoked: client removed'],
	['resource_changed', 'Sign-ins revoked: resource changed'],
	['application_removed', 'Sign-ins revoked: application deleted'],
])

function metadataReason(metadata: unknown): string | null {
	if (typeof metadata !== 'object' || metadata === null) return null
	const reason: unknown = Reflect.get(metadata, 'reason')
	return typeof reason === 'string' ? reason : null
}

/** Audit actions are open-ended. Preserve an unknown code so it can still be found in the audit log. */
export function auditActionLabel(action: string, metadata?: unknown): string {
	if (action === 'iam.oauth.grant.revoke') {
		const reason = metadataReason(metadata)
		const label = reason === null ? undefined : REVOCATION_LABELS.get(reason)
		if (label !== undefined) return label
	}
	return ACTION_LABELS.get(action) ?? action
}
