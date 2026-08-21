// The first-administrator flow against the REAL IAM admin router.
//
// Every other test in this unit stands up a fake `/admin/rpc`, which proves the flow but not the
// CONTRACT: the input shapes are zod schemas in `packages/iam/src/admin/rpc.ts`, and the whole reason
// this command exists is that two of them disagree about how a principal is named. So this one drives
// `ensureFirstAdministrator` through `createIamApp` over the harness's in-memory SQLite, with the
// provisioning key in the environment exactly as an installation holds it.
//
// The imports reach into `@fabrika/iam` by RELATIVE PATH because its `exports` map publishes only `.`,
// which resolves to the Cloudflare Worker entrypoint. `@fabrika/iam` is a devDependency all the same,
// so the manifest records the coupling the paths would otherwise hide. Test-only, and deliberately
// narrow: the app factory, its `Env`, and the shared harness.

import { createIamAdminClient, ensureFirstAdministrator } from '@fabrika/installation-init'
import { describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from '../../../iam/src/__tests__/helpers/harness'
import { createIamApp } from '../../../iam/src/app'
import type { Env } from '../../../iam/src/env'

const ORIGIN = 'https://iam.example.test'
const PROVISIONING_KEY = 'px_provisioning_key_for_this_test'
const EMAIL = 'operator@example.test'
const exec = { waitUntil(): void {} }

/** The admin surface never touches `DB` directly — the repositories are already built by the harness. */
const unusedDatabase: Env['DB'] = {
	prepare() {
		throw new Error('database access was not expected')
	},
	batch() {
		return Promise.reject(new Error('database access was not expected'))
	},
}

const iamEnv = (harness: Harness): Env => ({
	DB: unusedDatabase,
	REPOSITORIES: harness.repositories,
	HUMAN_EMAIL_DOMAINS: '[]',
	HUMAN_EMAILS: '[]',
	IAM_BOOTSTRAP_ADMINS: '[]',
	ADMIN_ORIGINS: '[]',
	ENVIRONMENT: 'stage',
	OIDC_ENABLED: 'false',
	PASSWORD_ENABLED: 'true',
	EMAIL_PROVIDER: 'none',
	ISSUER: ORIGIN,
	FABRIKA_IAM_SIGNING_KEYS: '',
	FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY,
	OIDC_ISSUER: 'https://idp.test',
	OIDC_CLIENT_ID: 'client',
	OIDC_CLIENT_SECRET: 'secret',
	OIDC_SCOPES: '',
	OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
})

/** The real client, with its fetch answered by the real app instead of the network. */
const liveIam = (harness: Harness) => {
	const app = createIamApp()
	const env = iamEnv(harness)
	return {
		client: createIamAdminClient({
			origin: ORIGIN,
			provisioningKey: PROVISIONING_KEY,
			fetch: (input, init) => app.fetch(new Request(input, init), env, exec),
		}),
		/** A raw call, for the shapes the typed client will not let a caller send. */
		raw: (method: string, input: unknown): Promise<Response> =>
			app.fetch(
				new Request(`${ORIGIN}/admin/rpc`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${PROVISIONING_KEY}` },
					body: JSON.stringify({ method, input }),
				}),
				env,
				exec,
			),
	}
}

describe('the first administrator, against the real admin router', () => {
	test('a fresh installation gets a principal, a cross-app admin grant and one enrollment URL', async () => {
		const { client } = liveIam(createHarness())

		const result = await ensureFirstAdministrator(client, { email: EMAIL })

		expect(result.principal).toBe('invited')
		expect(result.grant).toBe('created')
		expect(result.enrollment.state).toBe('issued')
		if (result.enrollment.state !== 'issued') {
			throw new Error('unreachable')
		}
		expect(new URL(result.enrollment.url).origin).toBe(ORIGIN)
	})

	test('the grant IAM stored is cross-app and role `admin` — read back off the real row', async () => {
		const { client } = liveIam(createHarness())

		const result = await ensureFirstAdministrator(client, { email: EMAIL })
		const detail = await client.principals.get({ id: result.principalId })

		expect(detail.grants).toHaveLength(1)
		expect(detail.grants[0]).toMatchObject({ app: null, roleKey: 'admin', scopeType: null, scopeValue: null, dangling: false })
		// The Access plane checks this exact action, and only a cross-app grant resolves it here.
		expect(detail.permissions.some((entry) => entry.action === '*' || entry.action === 'iam.admin')).toBe(true)
	})

	test('a re-run creates no second principal, no second grant and no second enrollment', async () => {
		const { client } = liveIam(createHarness())

		const first = await ensureFirstAdministrator(client, { email: EMAIL })
		const second = await ensureFirstAdministrator(client, { email: EMAIL })

		expect(second.principalId).toBe(first.principalId)
		expect(second.principal).toBe('existing')
		expect(second.grant).toBe('present')
		expect(second.enrollment).toEqual({ state: 'outstanding' })

		const users = await client.principals.list({ type: 'user' })
		expect(users.items.filter((item) => item.email === EMAIL)).toHaveLength(1)
		expect((await client.principals.get({ id: first.principalId })).grants).toHaveLength(1)
	})

	test('the two procedures really do disagree, and the command sends each the shape it wants', async () => {
		const { client, raw } = liveIam(createHarness())
		const result = await ensureFirstAdministrator(client, { email: EMAIL })

		// What a caller writing the obvious sequence sends, and what IAM answers.
		const enrollmentByPrincipalId = await raw('passwords.issueEnrollment', { principalId: result.principalId })
		expect(enrollmentByPrincipalId.status).toBe(400)
		const grantById = await raw('grants.create', { id: result.principalId, roleKey: 'admin', app: null })
		expect(grantById.status).toBe(400)

		// And what this command sends instead: `id` here, `principalId` there. Both accepted.
		expect((await raw('passwords.issueEnrollment', { id: result.principalId })).status).toBe(200)
		const other = await client.principals.invite({ email: 'second@example.test' })
		expect((await raw('grants.create', { principalId: other.id, roleKey: 'admin', app: null })).status).toBe(200)
	})

	test('a second identical grant is not something IAM absorbs — which is why the command checks first', async () => {
		const { client, raw } = liveIam(createHarness())
		const result = await ensureFirstAdministrator(client, { email: EMAIL })

		// Re-sending the grant a re-run would otherwise send does NOT succeed, so `grant: 'present'` is a
		// correctness requirement and not a nicety.
		expect((await raw('grants.create', { principalId: result.principalId, roleKey: 'admin', app: null })).status).not.toBe(200)
	})

	test('a wrong provisioning key is refused before anything is written', async () => {
		const harness = createHarness()
		const app = createIamApp()
		const env = iamEnv(harness)
		const client = createIamAdminClient({
			origin: ORIGIN,
			provisioningKey: 'px_not_the_installation_key',
			fetch: (input, init) => app.fetch(new Request(input, init), env, exec),
		})

		await expect(ensureFirstAdministrator(client, { email: EMAIL })).rejects.toThrow('principals.list failed')
		const trusted = liveIam(harness)
		expect((await trusted.client.principals.list({ type: 'user' })).items).toHaveLength(0)
	})
})
