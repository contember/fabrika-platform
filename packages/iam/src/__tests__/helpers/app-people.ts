// What the application-people tests share: an application with people of its own, and its administrator's console
// calls to IAM's `/admin/rpc`, as Control's gateway forwards them.

import type { AppSchema } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { createIamApp } from '../../app'
import { type AuditEventInput, type DelegatedAuthority, GrantRepository, type GrantRow } from '../../db'
import { prop } from '../../json'
import { adminTokenFor, TEST_SIGNING_KEYS } from './harness'
import { type MembershipFixture, NOTES_SCHEMA, ORIGIN } from './membership'

/** `NOTES_SCHEMA` with people of its own: `people.manage` administers them, `people.list` reads the directory. */
export const PEOPLE_SCHEMA: AppSchema = {
	...NOTES_SCHEMA,
	actions: [...NOTES_SCHEMA.actions, { action: 'people.manage' }, { action: 'people.list' }],
	roles: {
		...NOTES_SCHEMA.roles,
		// The application's administrator: it manages its people and holds what `staff` grants.
		administrator: { name: 'Administrator', permissions: ['people.manage', 'people.list', 'notes.read', 'notes.write', 'notes.share', 'notes.admin'] },
		reader: { name: 'Reader', permissions: ['people.list'] },
		publisher: NOTES_SCHEMA.roles['publisher'] ?? { name: 'Publisher', permissions: [] },
		auditor: { name: 'Auditor', permissions: ['notes.read', 'notes.publish'] },
	},
	members: { manage: 'people.manage', list: 'people.list' },
}

/** `PEOPLE_SCHEMA` whose `staff` also grants `notes.publish`, which the application's administrator does not hold. */
export const WIDENED_STAFF_SCHEMA: AppSchema = {
	...PEOPLE_SCHEMA,
	roles: {
		...PEOPLE_SCHEMA.roles,
		staff: { name: 'Staff', permissions: ['notes.read', 'notes.write', 'notes.share', 'notes.admin', 'notes.publish'] },
	},
}

/** Call `/admin/rpc` with the console token of `principalId`, as Control's gateway forwards it. */
export async function consoleRpc(
	f: MembershipFixture,
	principalId: string,
	method: string,
	input: unknown,
): Promise<{ status: number; body: unknown }> {
	return bearerRpc(f, await adminTokenFor(f.repositories, principalId, { issuer: ORIGIN }), method, input)
}

export async function bearerRpc(f: MembershipFixture, bearer: string, method: string, input: unknown): Promise<{ status: number; body: unknown }> {
	const response = await createIamApp().fetch(
		new Request(`${ORIGIN}/admin/rpc`, {
			method: 'POST',
			headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
			body: JSON.stringify({ method, input }),
		}),
		{
			DB: unusedDatabase,
			REPOSITORIES: f.repositories,
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
		f.ctx,
	)
	return { status: response.status, body: await response.json() }
}

export const result = (body: unknown): unknown => prop(body, 'result')
export const errorType = (body: unknown): unknown => prop(prop(body, 'error'), 'type')

/** Grants that run `between` once after a delegated change's check and before its write, as a concurrent writer would. */
export class DelegatedBetweenCheckAndWrite extends GrantRepository {
	between: (() => Promise<unknown>) | null = null

	override async createDelegatedRoleGrant(
		input: { principalId: string; roleKey: string; grantedBy: string; expiresAt?: number | null },
		authority: DelegatedAuthority,
		audit: (grantId: string) => AuditEventInput,
	): Promise<GrantRow | null> {
		await this.runBetween()
		return super.createDelegatedRoleGrant(input, authority, audit)
	}

	override async deleteDelegatedGrant(
		grant: Pick<GrantRow, 'id' | 'principal_id'>,
		authority: DelegatedAuthority,
		audit: AuditEventInput,
	): Promise<boolean> {
		await this.runBetween()
		return super.deleteDelegatedGrant(grant, authority, audit)
	}

	private async runBetween(): Promise<void> {
		const between = this.between
		this.between = null
		await between?.()
	}
}
