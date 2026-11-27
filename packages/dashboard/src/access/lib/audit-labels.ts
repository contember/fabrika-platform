import { ALL_ENVIRONMENTS } from '@fabrika/control-contract'
import { z } from 'zod'

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
	['iam.scim.token.rotate', 'Provisioning token created'],
	['iam.scim.token.revoke', 'Provisioning token removed'],
	['iam.scim.user.update', 'Account updated by the identity provider'],
	['iam.scim.user.delete', 'Account deleted by the identity provider'],
	['iam.external_app.put', 'External application saved'],
	['iam.external_app.delete', 'External application deleted'],
	['iam.oauth_client.put', 'Authoring client saved'],
	['iam.oauth_client.delete', 'Authoring client removed'],
	['iam.oauth_registry.import', 'OAuth client list imported'],
])

/** Control's own events (its use cases audit through IAM), and an approved request's execution, named by its procedure. */
const CONTROL_ACTION_LABELS = new Map<string, string>([
	['app.create', 'Application registered'],
	['app.update', 'Application source changed'],
	['app.delete', 'Application deleted'],
	['app.env.upsert', 'Environment saved'],
	['app.env.delete', 'Environment deleted'],
	['app.env.suspend', 'Environment taken offline'],
	['app.env.resume', 'Environment back online'],
	['app.env.token_key.rotate', 'Token key rotation requested'],
	['app.secret.set', 'Secret set'],
	['app.secret.upsert', 'Secret set'],
	['app.secret.rotate', 'Secret rotated'],
	['app.secret.delete', 'Secret deleted'],
	['app.var.upsert', 'Variable set'],
	['app.var.delete', 'Variable deleted'],
	['deploy.trigger', 'Deploy started'],
	['access.approve', 'Approval decided'],
	['access.protect', 'Approval rules changed'],
	['data.backups.schedule', 'Daily backups changed'],
	['namespace.create', 'Namespace created'],
	['namespace.adopt', 'Namespace adopted'],
	['namespace.reconcile', 'Namespace repaired'],
	['namespace.republish', 'Namespace proxy republished'],
	['namespace.update', 'Namespace changed'],
	['namespace.remove', 'Namespace removed'],
	['namespace.claims.release', 'Namespace resources released'],
	['source.connection.start', 'Source connection started'],
	['source.connection.handoff', 'Source connection handed to GitHub'],
	['source.connection.connected', 'Source connection connected'],
	['source.connection.cancel', 'Source connection cancelled'],
	['source.connection.repair', 'Source connection repaired'],
	['source.connection.reconcile', 'Source connection checked'],
	['source.workspace.create', 'Agent workspace created'],
	['source.workspace.commit', 'Agent workspace changed'],
	['source.workspace.abandon', 'Agent workspace abandoned'],
	['source.pull-request.create', 'Pull request opened'],
	['dev.bind', 'Dev sandbox started'],
	['dev.checks', 'Dev sandbox checks requested'],
	['dev.reset', 'Dev sandbox reset'],
	['apps.update', 'Approved request: application source changed'],
	['apps.environments.put', 'Approved request: environment saved'],
	['apps.environments.rotateTokenKey', 'Approved request: token key rotation'],
	['apps.environments.suspend', 'Approved request: environment taken offline'],
	['apps.secrets.put', 'Approved request: secret set'],
	['apps.secrets.delete', 'Approved request: secret deleted'],
	['vault.set', 'Approved request: secret set'],
	['vault.rotate', 'Approved request: secret rotated'],
	['apps.variables.put', 'Approved request: variable set'],
	['apps.variables.delete', 'Approved request: variable deleted'],
	['data.backups.setSchedule', 'Approved request: daily backups changed'],
	['data.start', 'Approved request: data operation'],
	['data.recover', 'Approved request: data recovery'],
	['iam.grants.create', 'Approved request: agent access'],
	['iam.apiKeys.provision', 'Approved request: API key'],
])

/**
 * The fields of a Control event's metadata a label or a subject reads, each parsed on its own: Control's events carry
 * other fields under the same names (a suspension's `state` is its data operation's), and one of another type must not
 * drop the rest.
 */
const controlMetadata = z.object({
	appId: z.string().optional().catch(undefined),
	env: z.string().optional().catch(undefined),
	decision: z.enum(['approve', 'reject']).optional().catch(undefined),
	partial: z.boolean().optional().catch(undefined),
	cancelled: z.boolean().optional().catch(undefined),
	daily: z.boolean().optional().catch(undefined),
	from: z.boolean().optional().catch(undefined),
	to: z.boolean().optional().catch(undefined),
	state: z.enum(['executed', 'failed', 'unknown']).optional().catch(undefined),
})

type ControlMetadata = z.infer<typeof controlMetadata>

function parseControlMetadata(metadata: unknown): ControlMetadata {
	const parsed = controlMetadata.safeParse(metadata)
	return parsed.success ? parsed.data : {}
}

/** An approved request's execution, audited under its procedure with the state it ended in. */
const APPROVED_REQUEST_ACTIONS = new Set(
	[...CONTROL_ACTION_LABELS.keys()].filter((action) => CONTROL_ACTION_LABELS.get(action)?.startsWith('Approved request')),
)

/** A label that depends on what the event did, where its metadata says; `null` falls back to the action's own. */
function controlOutcomeLabel(action: string, label: string, metadata: ControlMetadata): string | null {
	switch (action) {
		case 'deploy.trigger':
			return metadata.cancelled === true ? 'Deploy cancelled' : null
		case 'access.approve':
			if (metadata.decision === 'reject') return 'Change rejected'
			if (metadata.decision === 'approve') return metadata.partial === true ? 'Change approved by the first of two' : 'Change approved'
			return null
		case 'access.protect':
			if (metadata.from === false && metadata.to === true) return 'Approval turned on'
			if (metadata.from === true && metadata.to === false) return 'Approval turned off'
			return null
		case 'data.backups.schedule':
			return metadata.daily === undefined ? null : metadata.daily ? 'Daily backups turned on' : 'Daily backups turned off'
	}
	if (!APPROVED_REQUEST_ACTIONS.has(action)) return null
	if (metadata.state === 'failed') return `${label} (failed)`
	if (metadata.state === 'unknown') return `${label} (outcome unknown)`
	return null
}

/** The resources whose id Control writes as `<app>/<env>` or `<app>/<env or *>/<name>`. */
const CONTROL_RESOURCE_PARTS: ReadonlyMap<string, number> = new Map([['app_env', 2], ['app_secret', 3], ['app_var', 3]])

/**
 * What a Control event was about, in the console's words: `notes / prod`, `notes / all environments · API_KEY`. Read
 * from the id of an environment, a secret or a variable, else from the application and environment its metadata names;
 * `null` when it names neither, and the caller shows the id.
 */
export function controlAuditSubject(event: { resourceType: string; resourceId: string | null; metadata: unknown }): string | null {
	const parts = CONTROL_RESOURCE_PARTS.get(event.resourceType)
	const fromId = parts === undefined || event.resourceId === null ? [] : event.resourceId.split('/')
	const [appId, env, name] = fromId
	if (fromId.length === parts && fromId.every((part) => part !== '') && appId !== undefined && env !== undefined) return subject(appId, env, name)
	const metadata = parseControlMetadata(event.metadata)
	return metadata.appId === undefined ? null : subject(metadata.appId, metadata.env)
}

function subject(appId: string, env?: string, name?: string): string {
	const where = env === undefined ? appId : `${appId} / ${env === ALL_ENVIRONMENTS ? 'all environments' : env}`
	return name === undefined ? where : `${where} · ${name}`
}

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
	const control = CONTROL_ACTION_LABELS.get(action)
	if (control !== undefined) return controlOutcomeLabel(action, control, parseControlMetadata(metadata)) ?? control
	return ACTION_LABELS.get(action) ?? action
}
