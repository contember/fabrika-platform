/**
 * The read-only member directory (`ctx.members.list()`), end to end across the seam it crosses: the production proxy
 * decision (proxy-core's verify service, with a token cache as production keeps one) mints from the REAL IAM, the
 * application's `boot` asks the same IAM's `listMembers` with the caller's token, and IAM decides from the caller's
 * live permissions and the schema the application's contract compiles to.
 *
 * It lives OUTSIDE `src/` for the reason `console-access-plane.test.ts` does: it reaches into three other packages.
 */

import { defineApp, defineVocabulary, schemaFromContract } from '@fabrika/app/contract'
import { boot, type ContractApp, serve } from '@fabrika/app/implement'
import { type ContractArtifact, contractDigest, FABRIKA_CONTRACT_DIGEST, FABRIKA_IAM_APP_ID, FABRIKA_IAM_ISSUER } from '@fabrika/auth-core'
import { MemoryTokenCache, stripFabrikaCookies } from '@fabrika/proxy-core'
import { describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { compileContract } from '../../app/src/contract/compile'
import { endpointProxy } from '../../app/src/testing/proxy'
import { createHarness, TEST_SIGNING_KEYS } from '../../iam/src/__tests__/helpers/harness'
import { APP, type MembershipFixture, membershipFixture, ORIGIN, type Person } from '../../iam/src/__tests__/helpers/membership'
import type { Env } from '../../iam/src/env'
import { unixNow } from '../../iam/src/repositories/sql'
import { createIamRpc } from '../../iam/src/rpc'
import { hashToken } from '../../iam/src/secret'

const HOST = 'notes.test'
const Assignees = z.strictObject({ members: z.array(z.strictObject({ id: z.string(), label: z.nullable(z.string()) })) })
const ByWorkspace = z.strictObject({ workspaceId: z.string() })

/** The application, its workspace members listed by an endpoint whose action is the dimension's `members.list`. */
function application(labels: boolean) {
	const vocabulary = labels
		? defineVocabulary({
			app: 'notes',
			dimensions: { workspace: { creator: 'owner', members: { manage: 'notes.admin', list: 'notes.read' }, directory: 'labels' } },
			actions: { 'notes.read': 'Read the workspace', 'notes.admin': 'Manage the workspace and its members' },
			roles: {
				owner: { grants: ['notes.read', 'notes.admin'], member: { scope: 'workspace', assignableBy: ['owner'] } },
				member: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } },
			},
		})
		: defineVocabulary({
			app: 'notes',
			dimensions: { workspace: { creator: 'owner', members: { manage: 'notes.admin', list: 'notes.read' } } },
			actions: { 'notes.read': 'Read the workspace', 'notes.admin': 'Manage the workspace and its members' },
			roles: {
				owner: { grants: ['notes.read', 'notes.admin'], member: { scope: 'workspace', assignableBy: ['owner'] } },
				member: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } },
			},
		})
	const app = defineApp(vocabulary)
	const workspaces = app.group({ callers: ['human'] }, (r) => ({
		assignees: r.query({ input: ByWorkspace, output: Assignees, access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' } })
			.handle(async ({ ctx }) => ({ members: (await ctx.members.list()).map((member) => ({ id: member.principalId, label: member.label })) })),
	}))
	return serve(app.contract((c) => ({ api: c.rpc('/api', { workspaces }) })), { database: null })
}

const exec = { waitUntil() {} }

const unusedDatabase = {
	prepare(): never {
		throw new Error('database access goes through REPOSITORIES in this test')
	},
	batch(): Promise<never> {
		return Promise.reject(new Error('database access goes through REPOSITORIES in this test'))
	},
}

function iamEnv(f: MembershipFixture): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: f.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

interface Stack {
	readonly f: MembershipFixture
	/** A request with `key` as its bearer, through the proxy into the application. */
	assignees(key: string, workspaceId: string): Promise<Response>
	/** A person holding `role` in each workspace, with a `px_` key of their own. */
	member(name: string, role: 'owner' | 'member', ...workspaces: string[]): Promise<Person & { readonly key: string }>
	revoke(person: Person, role: 'owner' | 'member', workspace: string): Promise<void>
}

/** IAM with the application's schema, the production proxy in front of the application, and the application's boot. */
async function stack(labels: boolean, options: { readonly membership?: boolean } = {}): Promise<Stack> {
	const f = await membershipFixture(createHarness().repositories)
	const served = application(labels)
	const artifact: ContractArtifact = compileContract(served.contract, {})
	expect((await f.putSchema(schemaFromContract(artifact))).status).toBe(200)
	const iam = createIamRpc(iamEnv(f), exec)
	const proxy = endpointProxy({ artifact, appId: APP, host: HOST, iam, issuer: ORIGIN, delegations: iam, cache: new MemoryTokenCache() })
	const app: ContractApp = boot(served, {
		environment: {
			framework: { [FABRIKA_IAM_APP_ID]: APP, [FABRIKA_IAM_ISSUER]: ORIGIN, [FABRIKA_CONTRACT_DIGEST]: contractDigest(artifact) },
			application: {},
		},
		iam: { getJwks: () => iam.getJwks() },
		assets: { serve: () => Promise.resolve(new Response('')) },
		...(options.membership === false ? {} : { membership: iam }),
	})
	let seq = 0
	return {
		f,
		async assignees(key, workspaceId) {
			const request = new Request(`https://${HOST}/api/workspaces.assignees`, {
				method: 'POST',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({ workspaceId }),
			})
			const outcome = await proxy({ method: request.method, url: request.url, headers: new Headers(request.headers) })
			if (outcome.outcome === 'answer') return outcome.response
			const headers = new Headers(request.headers)
			stripFabrikaCookies(headers)
			if (!outcome.keepsAuthorization) headers.delete('authorization')
			for (const [header, value] of outcome.asserted) headers.set(header, value)
			return app.fetch(new Request(request, { headers }))
		},
		async member(name, role, ...workspaces) {
			const person = await f.person(name)
			for (const value of workspaces) {
				await f.repositories.membership.grantMembershipRole({
					app: APP,
					principalId: person.id,
					roleKey: role,
					scope: { type: 'workspace', value },
					grantedBy: person.id,
				})
			}
			seq += 1
			const key = `px_member-directory-${name}-${seq}-0123456789abcdef`
			await f.repositories.credentials.createCredential({
				tokenHash: await hashToken(key),
				principalId: person.id,
				app: APP,
				issuedBy: person.id,
				expiresAt: unixNow() + 3600,
				grants: [],
			})
			return { ...person, key }
		},
		async revoke(person, role, workspace) {
			await f.repositories.membership.deleteRoleGrant(APP, person.id, role, { type: 'workspace', value: workspace })
		},
	}
}

async function listed(response: Response): Promise<{ id: string; label: string | null }[]> {
	expect(response.status).toBe(200)
	const body = Assignees.parse(z.strictObject({ result: z.unknown() }).parse(await response.json()).result)
	return body.members.sort((a, b) => a.id.localeCompare(b.id))
}

describe('ctx.members.list() through the proxy and IAM', () => {
	test('a member lists the members of its own workspace only, without their labels by default', async () => {
		const s = await stack(false)
		const owner = await s.member('owner', 'owner', 'w1')
		const member = await s.member('member', 'member', 'w1')
		await s.member('elsewhere', 'member', 'w2')
		expect(await listed(await s.assignees(member.key, 'w1'))).toEqual(
			[{ id: owner.id, label: null }, { id: member.id, label: null }].sort((a, b) => a.id.localeCompare(b.id)),
		)
		// The owner holds members.manage there, so IAM shows it the labels.
		expect((await listed(await s.assignees(owner.key, 'w1'))).map((entry) => entry.label).sort()).toEqual(['member@example.test', 'owner@example.test'])
	})

	test("a dimension that declares directory: 'labels' shows the labels to a member", async () => {
		const s = await stack(true)
		const owner = await s.member('owner', 'owner', 'w1')
		const member = await s.member('member', 'member', 'w1')
		expect(await listed(await s.assignees(member.key, 'w1'))).toEqual(
			[{ id: owner.id, label: 'owner@example.test' }, { id: member.id, label: 'member@example.test' }].sort((a, b) => a.id.localeCompare(b.id)),
		)
	})

	test('a member of another workspace holds the action elsewhere: the proxy admits it, the access form refuses it before IAM is asked', async () => {
		const s = await stack(true)
		await s.member('owner', 'owner', 'w1')
		const outsider = await s.member('outsider', 'member', 'w2')
		const refused = await s.assignees(outsider.key, 'w1')
		expect(refused.status).toBe(403)
		expect(await refused.text()).toContain("The caller does not hold 'notes.read' in this workspace")
	})

	test('a caller without the action anywhere is refused by the proxy', async () => {
		const s = await stack(true)
		const stranger = await s.member('stranger', 'member')
		const refused = await s.assignees(stranger.key, 'w1')
		expect(refused.status).toBe(403)
		expect(await refused.text()).toBe('forbidden')
	})

	test("a membership revoked after the proxy's token was issued is refused by IAM's live check", async () => {
		const s = await stack(true)
		await s.member('owner', 'owner', 'w1')
		const member = await s.member('member', 'member', 'w1')
		expect((await listed(await s.assignees(member.key, 'w1'))).length).toBe(2)
		await s.revoke(member, 'member', 'w1')
		// The proxy serves its cached token, which still names the role; IAM checks the permission live.
		const refused = await s.assignees(member.key, 'w1')
		expect(refused.status).toBe(403)
		expect(await refused.text()).toContain('IAM checked its live permissions')
	})

	test('without an IAM membership transport the application boots, and only list() answers 503', async () => {
		const s = await stack(false, { membership: false })
		const member = await s.member('member', 'member', 'w1')
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await s.assignees(member.key, 'w1')).status).toBe(503)
		} finally {
			log.mockRestore()
		}
	})
})
