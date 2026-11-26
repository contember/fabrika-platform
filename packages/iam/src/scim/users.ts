// What a SCIM write changes in IAM (ADR-0091). A user is a `user` principal; its SCIM id is the principal's id.
//
// Deprovisioning is immediate at IAM: `active=false` and DELETE disable the principal and, in the same transaction,
// revoke every session (an application session is revoked with its parent and by its own row), every `px_` key bound
// to it, every OAuth grant, and spend every pending password action. The next mint, key exchange, refresh or `/admin`
// call is refused. A token a proxy already cached stays valid until it expires (ADR-0022, `DEFAULT_TOKEN_TTL_SECONDS`).

import { uuidv7 } from '@fabrika/platform'
import { IAM_APP } from '../admin/router'
import { credentialsRefusal, issuedKeysReach } from '../credentials-gate'
import { normalizeEmailIdentity } from '../email-identity'
import type { AuditEventInput, SqlChange } from '../repositories/audit'
import type { ScimUserAttributes, ScimUserRecord } from '../repositories/scim'
import { unixNow } from '../repositories/sql'
import type { Services } from '../services'
import { ScimError, type ScimUserState, stateOf, userNameKey } from './resource'

/** Who a SCIM write is recorded as: the installation's token, never a principal. */
export interface ScimActor {
	readonly tokenId: string
	readonly requestId: string
}

/** The audit label of every SCIM change; the token's id is in its metadata. */
export const SCIM_ACTOR_LABEL = 'scim'

/** The issuer a re-enabling is judged as (ADR-0083 §8): a machine caller, never a person. */
const SCIM_ISSUER = { id: SCIM_ACTOR_LABEL, person: false } as const

function scimEvent(actor: ScimActor, principalId: string, action: string, metadata: Record<string, unknown> = {}): AuditEventInput {
	return {
		requestId: actor.requestId,
		principalId: null,
		principalLabel: SCIM_ACTOR_LABEL,
		app: IAM_APP,
		action,
		resourceType: 'principal',
		resourceId: principalId,
		metadata: { via: 'scim', token: actor.tokenId, ...metadata },
	}
}

/**
 * Whether SCIM sees a principal at all: an internal user (the organization's identity provider claims no external
 * person, ADR-0051), never the installation's bootstrap administrator (its break-glass account stays out of the
 * provider's reach), and not one the provider deleted.
 */
export function visible(services: Services, record: ScimUserRecord): boolean {
	return record.type === 'user'
		&& record.affiliation === 'internal'
		&& (record.email === null || !services.config.bootstrapAdmins.has(record.email))
		&& (record.linked_at === null || record.deleted_at === null)
}

function attributesOf(state: ScimUserState): ScimUserAttributes {
	return {
		userName: state.userName,
		userNameKey: userNameKey(state.userName),
		externalId: state.externalId,
		displayName: state.displayName,
		givenName: state.givenName,
		familyName: state.familyName,
	}
}

/**
 * Provision a user. A mailbox no principal holds creates an internal principal that its first OIDC login claims; a
 * mailbox an unprovisioned user, or one the provider deleted, holds links that principal: the provider takes over a
 * person who signed in before provisioning started.
 */
export async function createUser(services: Services, actor: ScimActor, state: ScimUserState): Promise<{ record: ScimUserRecord; created: boolean }> {
	const { scim } = services.repositories
	const mailbox = normalizeEmailIdentity(state.email)
	// Before anything is looked up: the bootstrap principal may not exist yet, and SCIM must not create it.
	requireNotBootstrap(services, mailbox)
	await requireFreeUserName(services, state.userName, null)
	const existing = await scim.getByMailbox(mailbox)
	if (existing !== null) {
		if (existing.affiliation !== 'internal') {
			throw new ScimError(409, 'uniqueness', 'an external person holds this mailbox, and SCIM does not manage external people')
		}
		if (existing.linked_at !== null && existing.deleted_at === null) {
			throw new ScimError(409, 'uniqueness', 'a user with this mailbox is already provisioned')
		}
		return { record: await saveUser(services, actor, existing, state), created: false }
	}
	const id = uuidv7()
	const now = unixNow()
	try {
		await scim.provision(
			services.repositories.principals.provisionUserStatements(id, state.email, !state.active),
			id,
			attributesOf(state),
			now,
			scimEvent(actor, id, 'iam.principal.create', { active: state.active }),
		)
	} catch (cause) {
		// Another writer took the mailbox or the userName first.
		if ((await scim.getByMailbox(mailbox)) !== null || (await scim.getByUserName(userNameKey(state.userName))) !== null) {
			throw new ScimError(409, 'uniqueness', 'a user with this mailbox or userName already exists')
		}
		throw cause
	}
	return { record: await requireRecord(services, id), created: true }
}

/** Write `next` over the user `record` holds; returns the record after the write. */
export async function saveUser(services: Services, actor: ScimActor, record: ScimUserRecord, next: ScimUserState): Promise<ScimUserRecord> {
	const { principals, scim, audit } = services.repositories
	const current = stateOf(record)
	const mailbox = normalizeEmailIdentity(next.email)
	requireNotBootstrap(services, mailbox)
	await requireFreeUserName(services, next.userName, record.id)
	const moving = mailbox !== record.email
	if (moving) {
		const holder = await scim.getByMailbox(mailbox)
		if (holder !== null && holder.id !== record.id) throw new ScimError(409, 'uniqueness', 'another user holds this mailbox')
	}
	if (next.active && !current.active) {
		// Re-enabling gives back what every key the person issued for others holds, judged as the console judges it.
		const refusal = await credentialsRefusal(services, SCIM_ISSUER, await issuedKeysReach(services, record.id, { kind: 'all' }), 'enable')
		if (refusal !== null) throw new ScimError(403, null, refusal)
	}
	const now = unixNow()
	const moved = principals.changeMailbox(record.id, next.email)
	const statements = [
		...principals.lockStatements(record.id),
		...audit.writer.changed(
			[moved.change, scim.linkChange(record.id, attributesOf(next), now), ...(moving ? mailboxMoveChanges(services, record.id, now) : [])],
			scimEvent(actor, record.id, 'iam.scim.user.update', { linked: record.linked_at === null || record.deleted_at !== null, mailboxMoved: moving }),
		).statements,
		moved.claim,
		...activityStatements(services, actor, record.id, current.active, next.active, now),
	]
	try {
		await audit.commit(statements)
	} catch (cause) {
		const holder = await scim.getByMailbox(mailbox)
		const named = await scim.getByUserName(userNameKey(next.userName))
		if ((holder !== null && holder.id !== record.id) || (named !== null && named.id !== record.id)) {
			throw new ScimError(409, 'uniqueness', 'another user holds this mailbox or userName')
		}
		throw cause
	}
	return requireRecord(services, record.id)
}

/** DELETE: deprovision the user and mark its link deleted, in one transaction. The principal and its history stay. */
export async function deleteUser(services: Services, actor: ScimActor, record: ScimUserRecord): Promise<void> {
	const { principals, scim, audit } = services.repositories
	const now = unixNow()
	const linked = record.linked_at === null
		// A principal the provider found by its mailbox and never wrote is linked as it is deleted.
		? [scim.linkStatement(record.id, attributesOf(stateOf(record)), now)]
		: []
	await audit.commit([
		...principals.lockStatements(record.id),
		...linked,
		...audit.writer.changed(deprovisionChanges(services, record.id, now), scimEvent(actor, record.id, 'iam.principal.disable')).statements,
		...audit.writer.changed([scim.deleteChange(record.id, now)], scimEvent(actor, record.id, 'iam.scim.user.delete')).statements,
	])
}

/**
 * The write of `active`. Only a change of what the write read is written, so a write of other attributes that read the
 * person active cannot enable them again after a concurrent `active=false`. Deprovisioning is idempotent and always
 * runs for `active=false`. An enabling also ends whatever a login racing the deprovisioning left behind: a disabled
 * person holds nothing, so re-enabling restores nothing.
 */
function activityStatements(services: Services, actor: ScimActor, principalId: string, was: boolean, next: boolean, now: number) {
	const { principals, audit } = services.repositories
	if (!next) {
		return audit.writer.changed(deprovisionChanges(services, principalId, now), scimEvent(actor, principalId, 'iam.principal.disable')).statements
	}
	if (was) return []
	return audit.writer.changed(
		[principals.enablePrincipalChange(principalId), ...accessChanges(services, principalId, now)],
		scimEvent(actor, principalId, 'iam.principal.enable'),
	).statements
}

/** Everything that lets the person in, ended, and the principal disabled. Independent changes: one Postgres snapshot. */
function deprovisionChanges(services: Services, principalId: string, now: number): SqlChange[] {
	return [...accessChanges(services, principalId, now), services.repositories.principals.disablePrincipalChange(principalId)]
}

/** Every session, own `px_` key and OAuth grant of the person ended, and every pending password action spent. */
function accessChanges(services: Services, principalId: string, now: number): SqlChange[] {
	const { sessions, credentials, oauth, principals } = services.repositories
	return [
		sessions.revokeSessionsForPrincipalChange(principalId),
		credentials.revokeCredentialsForPrincipalChange(principalId),
		oauth.revokeGrantsForPrincipalChange(principalId, now),
		principals.consumePasswordActionsChange(principalId),
	]
}

/**
 * A moved mailbox ends the person's sessions, spends their password actions and switches password login off: the
 * provider vouches for the new address, not for whoever reads it, so a password reset sent there must not open the
 * account. Single sign-on, which matches the person by subject first, is unaffected.
 */
function mailboxMoveChanges(services: Services, principalId: string, now: number): SqlChange[] {
	const { sessions, principals, passwords } = services.repositories
	return [
		sessions.revokeSessionsForPrincipalChange(principalId),
		principals.consumePasswordActionsChange(principalId),
		...passwords.disableLoginChanges(principalId, now),
	]
}

function requireNotBootstrap(services: Services, mailbox: string): void {
	if (services.config.bootstrapAdmins.has(mailbox)) {
		throw new ScimError(409, 'uniqueness', "the mailbox is the installation's bootstrap administrator, which SCIM does not manage")
	}
}

async function requireFreeUserName(services: Services, userName: string, self: string | null): Promise<void> {
	const named = await services.repositories.scim.getByUserName(userNameKey(userName))
	if (named !== null && named.id !== self) throw new ScimError(409, 'uniqueness', 'another user has this userName')
}

async function requireRecord(services: Services, id: string): Promise<ScimUserRecord> {
	const record = await services.repositories.scim.getRecord(id)
	if (record === null) throw new ScimError(404, null, 'user not found')
	return record
}
