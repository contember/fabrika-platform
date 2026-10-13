import { type AppSchema, buildAccessClaims, type WorkloadKind } from '@fabrika/auth-core'
import type { Scope } from '@fabrika/auth-core'
import type { EmailDeliveryResult, EmailMessage, EmailSender } from '@fabrika/email'
import type { SqlDatabase } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import { handleAdmin } from '../../admin/router'
import { createIamApp } from '../../app'
import {
	type AuditEventInput,
	type IamRepositories,
	type InvitationRow,
	MembershipRepository,
	type MembershipRepositoryOptions,
	type PrincipalRow,
} from '../../db'
import type { RequestContext } from '../../env'
import type { InvitationAcceptance } from '../../repositories/membership'
import { resolvePermissionsAt } from '../../resolve'
import { generateToken, hashToken } from '../../secret'
import type { Services } from '../../services'
import { getSigner } from '../../signing'
import { mintFromKey } from '../../tokens'
import { adminTokenFor, makeServicesFor, type MakeServicesOptions, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './harness'

// A multi-tenant application for the membership witnesses (ADR-0012 §6), reconciled
// through the real admin PUT so its declarations pass the same validation a deploy's do.

export const ORIGIN = 'https://iam.example.com'
export const APP = 'notes@prod'
export const INVITE_ENDPOINT = 'api.workspaces.invite'
export const CREATE_ENDPOINT = 'api.workspaces.create'

export const NOTES_SCHEMA: AppSchema = {
	contract: true,
	scopes: [
		{ type: 'workspace', creator: 'owner', members: { manage: 'notes.admin', list: 'notes.read' } },
		{ type: 'note', in: 'workspace' },
	],
	actions: [
		{ action: 'notes.read' },
		{ action: 'notes.write' },
		{ action: 'notes.share' },
		{ action: 'notes.publish' },
		{ action: 'notes.admin' },
		{ action: 'workspaces.create' },
	],
	roles: {
		starter: { name: 'Starter', permissions: ['workspaces.create'] },
		support: { name: 'Support', permissions: ['notes.read', 'notes.admin'] },
		// An application-wide role that assigns an editor in every workspace it holds the actions in.
		staff: { name: 'Staff', permissions: ['notes.read', 'notes.write', 'notes.share', 'notes.admin'] },
		editor: {
			name: 'Editor',
			permissions: ['notes.read', 'notes.write', 'notes.share'],
			member: { scope: 'workspace', assignableBy: ['owner', 'manager', 'staff'] },
		},
		manager: {
			name: 'Manager',
			permissions: ['notes.read', 'notes.write', 'notes.share', 'notes.admin'],
			member: { scope: 'workspace', assignableBy: ['owner'] },
		},
		owner: {
			name: 'Owner',
			permissions: ['notes.read', 'notes.write', 'notes.share', 'notes.admin'],
			member: { scope: 'workspace', assignableBy: ['owner'] },
		},
		publisher: { name: 'Publisher', permissions: ['notes.read', 'notes.publish'], member: { scope: 'workspace', assignableBy: ['owner'] } },
	},
	links: { shared: { dimension: 'note', grants: ['notes.read'], issuedBy: 'notes.share', maxDays: 30 } },
	delegations: {
		[INVITE_ENDPOINT]: { action: 'notes.admin', dimension: 'workspace', purpose: 'members' },
		[CREATE_ENDPOINT]: { action: 'workspaces.create', dimension: 'workspace', purpose: 'creates' },
	},
}

export class CapturingEmail implements EmailSender {
	readonly messages: EmailMessage[] = []
	constructor(private readonly fail = false) {}

	send(message: EmailMessage): Promise<EmailDeliveryResult> {
		this.messages.push(message)
		if (this.fail) return Promise.reject(new Error('delivery failed'))
		return Promise.resolve({ status: 'accepted', provider: 'test', messageId: `message-${this.messages.length}` })
	}

	/** The one-time token of the latest invitation, read from its link's fragment. */
	lastToken(): string {
		const text = this.messages.at(-1)?.text ?? ''
		const link = /https?:\/\/\S+/.exec(text)?.[0]
		const token = link === undefined ? null : new URLSearchParams(new URL(link).hash.slice(1)).get('token')
		if (token === null) throw new Error('no invitation link in the last email')
		return token
	}
}

export class PendingWork implements RequestContext {
	readonly pending: Promise<unknown>[] = []
	readonly waitUntil = (promise: Promise<unknown>): void => {
		this.pending.push(promise)
	}

	async settle(): Promise<void> {
		await Promise.all(this.pending)
	}
}

export const CALLER_ENV = { ...TEST_SIGNING_ENV, FABRIKA_IAM_PROVISIONING_KEY: '' }

export interface Person {
	readonly id: string
	/** A native access token for `APP` (or `app`) carrying the person's permissions now, as a mint would sign it. */
	token(app?: string): Promise<string>
}

/** Sign what `mintToken` would: the principal's permissions at `app` as they are now. */
export async function mintedToken(services: Services, principal: PrincipalRow, app: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const signer = await getSigner(TEST_SIGNING_ENV)
	return signer.sign(buildAccessClaims({
		iss: ORIGIN,
		app,
		subject: principal.id,
		type: principal.type,
		label: principal.label,
		permissions: await resolvePermissionsAt(services, principal, app),
		issuedAt: now,
		expiresAt: now + 300,
	}))
}

/** A job's or a webhook's principal, its `px_` key, and the token IAM signs from that key now. */
export interface Workload {
	readonly id: string
	readonly key: string
	token(): Promise<string>
}

export interface MembershipFixture {
	readonly repositories: IamRepositories
	readonly services: Services
	readonly ctx: PendingWork
	person(name: string): Promise<Person>
	/** A person from outside the organization, created as an installation administrator creates one (ADR-0051). */
	external(name: string): Promise<Person>
	/** Call `/admin/rpc` as the fixture's installation administrator. */
	adminRpc(method: string, input: unknown): Promise<Response>
	/** A workload key, issued as Control issues it (`workloads.issueKey`). */
	workload(kind: WorkloadKind, name: string): Promise<Workload>
	putSchema(schema: AppSchema): Promise<Response>
}

export async function membershipFixture(
	repositories: IamRepositories,
	options: { email?: EmailSender | null; services?: Omit<MakeServicesOptions, 'environment' | 'issuer' | 'email'> } = {},
): Promise<MembershipFixture> {
	const services = makeServicesFor(repositories, { ...options.services, environment: 'stage', issuer: ORIGIN, email: options.email ?? null })
	const ctx = new PendingWork()
	// Unique per fixture, so several fixtures can share one Postgres schema.
	const tag = crypto.randomUUID()
	const admin = await repositories.principals.createUser(`sub-iam-admin-${tag}`, `iam-admin-${tag}@example.test`)
	await repositories.grants.createGrant({ principalId: admin.id, roleKey: 'admin' })
	const adminBearer = await adminTokenFor(repositories, admin.id, { issuer: ORIGIN })

	const putSchema = (schema: AppSchema): Promise<Response> =>
		handleAdmin(
			new Request(`${ORIGIN}/admin/apps/${encodeURIComponent(APP)}/schema`, {
				method: 'PUT',
				headers: { authorization: `Bearer ${adminBearer}`, 'content-type': 'application/json' },
				body: JSON.stringify(schema),
			}),
			services,
			CALLER_ENV,
			ctx,
		)
	const reconciled = await putSchema(NOTES_SCHEMA)
	if (reconciled.status !== 200) throw new Error(`schema refused: ${await reconciled.text()}`)

	return {
		repositories,
		services,
		ctx,
		putSchema,
		async person(name: string): Promise<Person> {
			const principal = await repositories.principals.createUser(`sub-${name}`, `${name}@example.test`)
			return { id: principal.id, token: (app = APP) => mintedToken(services, principal, app) }
		},
		async external(name: string): Promise<Person> {
			const principal = await repositories.principals.inviteUser(`${name}@partner.test`, `${name}@partner.test`, undefined, 'external')
			return { id: principal.id, token: (app = APP) => mintedToken(services, principal, app) }
		},
		adminRpc: async (method: string, input: unknown): Promise<Response> =>
			createIamApp().fetch(
				new Request(`${ORIGIN}/admin/rpc`, {
					method: 'POST',
					headers: { authorization: `Bearer ${adminBearer}`, 'content-type': 'application/json' },
					body: JSON.stringify({ method, input }),
				}),
				{
					DB: unusedDatabase,
					REPOSITORIES: repositories,
					HUMAN_EMAIL_DOMAINS: '[]',
					HUMAN_EMAILS: '[]',
					IAM_BOOTSTRAP_ADMINS: '[]',
					ENVIRONMENT: 'stage',
					ISSUER: ORIGIN,
					FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
					FABRIKA_IAM_PROVISIONING_KEY: '',
					OIDC_ISSUER: 'https://idp.test',
					OIDC_CLIENT_ID: 'client',
					OIDC_CLIENT_SECRET: 'secret',
					OIDC_SCOPES: '',
					OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
				},
				ctx,
			),
		async workload(kind: WorkloadKind, name: string): Promise<Workload> {
			const key = `px_${generateToken()}`
			const id = await repositories.workloads.issueKey(
				{
					app: APP,
					kind,
					name,
					credentialId: crypto.randomUUID(),
					tokenHash: await hashToken(key),
					issuedBy: admin.id,
					expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
					keep: null,
				},
				{
					requestId: 'req-workload-key',
					principalId: admin.id,
					principalLabel: 'admin',
					app: APP,
					action: 'iam.workload.key.issue',
					resourceType: 'principal',
				},
			)
			return {
				id,
				key,
				async token() {
					const { result: minted } = await mintFromKey(services, TEST_SIGNING_ENV, { app: APP, key, requestId: 'req-workload' })
					if (!minted.ok) throw new Error(`no workload token: ${minted.reason}`)
					return minted.token
				},
			}
		},
	}
}

/**
 * The deterministic interleaving of an acceptance and a removal: the inviter's role is removed after
 * `acceptInvitation` checked the inviter's authority and before the write that consumes the invitation.
 */
export class InviterRemovedBeforeAcceptance extends MembershipRepository {
	removeBeforeAcceptance: { app: string; principalId: string; roleKey: string; scope: Scope } | null = null

	constructor(db: SqlDatabase, options: MembershipRepositoryOptions = {}) {
		super(db, options)
	}

	override async acceptInvitation(
		invitation: InvitationRow,
		principalId: string,
		assigners: readonly string[],
		audit?: AuditEventInput,
	): Promise<InvitationAcceptance> {
		const removal = this.removeBeforeAcceptance
		if (removal !== null) {
			await this.deleteRoleGrant(removal.app, removal.principalId, removal.roleKey, removal.scope)
		}
		return super.acceptInvitation(invitation, principalId, assigners, audit)
	}
}
