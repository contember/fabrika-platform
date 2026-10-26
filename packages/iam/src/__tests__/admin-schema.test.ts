import type { AppSchemaDto, GrantDto, PolicyDto, RoleDto } from '@fabrika/iam-contract'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { handleAdmin } from '../admin/router'
import { createIamApp } from '../app'
import type { Env, RequestContext } from '../env'
import type { Services } from '../services'
import { createHarness, type Harness, seedAppAction, seedGrant, seedUser, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'

const ADMIN_ENV: Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'FABRIKA_IAM_PROVISIONING_KEY' | 'ENVIRONMENT'> = {
	...TEST_SIGNING_ENV,
	FABRIKA_IAM_PROVISIONING_KEY: '',
}

// End-to-end admin tests for the app-vocabulary surfaces:
//   - PUT/GET /admin/apps/:app/schema — idempotent reconcile + readback, over REST because a DEPLOY
//     calls it from outside the installation (one of the two surviving REST operations);
//   - custom policies survive a re-reconcile;
//   - action-catalog validation rejects unknown actions on schema + policy + grant;
//   - grant create enforces role XOR inline, validates inline against the catalog, and enforces
//     both-or-neither scope.
// Everything except the schema reconcile is `/admin/rpc`, which is the only transport that serves it.
// Both are driven with the console's bearer (the proxy token Control forwards + real Db over bun:sqlite).

const ORIGIN = 'https://iam.example.com'
const exec = { waitUntil() {} }
class FakeRequestContext implements RequestContext {
	readonly pending: Promise<unknown>[] = []
	waitUntil(promise: Promise<unknown>): void {
		this.pending.push(promise)
	}
}

// The target app ('opice') registers itself by reconciling its schema (`PUT …/opice/schema`), which
// is how it lands in the DB-derived `knownApps` registry — no static config list anymore.
function adminServices(h: Harness): Services {
	return h.makeServices({ environment: 'stage', issuer: ORIGIN })
}

function env(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
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
	}
}

// Seed a global admin user and sign its console bearer so every request clears the gate.
async function asAdmin(h: Harness): Promise<string> {
	const id = seedUser(h.sqlite, { sub: 'sub-admin', email: 'admin@example.com' })
	seedGrant(h.sqlite, id, 'admin', null) // built-in admin, global, cross-app
	return h.adminToken(id, { issuer: ORIGIN })
}

function req(path: string, method: string, bearer: string, body?: unknown): Request {
	const headers = new Headers({ Authorization: `Bearer ${bearer}` })
	if (method !== 'GET') {
		headers.set('Content-Type', 'application/json')
	}
	return new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

async function run(h: Harness, request: Request): Promise<Response> {
	return handleAdmin(request, adminServices(h), ADMIN_ENV, new FakeRequestContext())
}

/** One `/admin/rpc` call as the bearer's admin; returns the status and the parsed envelope. */
async function rpc(h: Harness, bearer: string, method: string, input: unknown): Promise<{ status: number; body: unknown }> {
	const response = await createIamApp().fetch(
		new Request(`${ORIGIN}/admin/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
			body: JSON.stringify({ method, input }),
		}),
		env(h),
		exec,
	)
	return { status: response.status, body: await response.json() }
}

/** The `result` of a call expected to succeed, narrowed by the caller's DTO type. */
async function result<T>(h: Harness, bearer: string, method: string, input: unknown, narrow: (value: unknown) => T): Promise<T> {
	const { status, body } = await rpc(h, bearer, method, input)
	expect(status).toBe(200)
	if (body === null || typeof body !== 'object' || !('result' in body)) {
		throw new Error(`expected a result envelope from ${method}`)
	}
	return narrow(body.result)
}

/** The error message of a call expected to fail with `status`. */
async function failure(h: Harness, bearer: string, method: string, input: unknown, status: number): Promise<string> {
	const response = await rpc(h, bearer, method, input)
	expect(response.status).toBe(status)
	const body = response.body
	if (body === null || typeof body !== 'object' || !('error' in body)) {
		throw new Error(`expected an error envelope from ${method}`)
	}
	const error = body.error
	return error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : ''
}

function asPolicies(value: unknown): PolicyDto[] {
	return z.object({
		items: z.array(z.object({
			app: z.string(),
			key: z.string(),
			name: z.string(),
			permissions: z.array(z.string()),
			createdAt: z.number(),
		})),
	}).parse(value).items
}

function asRoles(value: unknown): RoleDto[] {
	return z.object({
		items: z.array(z.object({
			key: z.string(),
			name: z.string(),
			permissions: z.array(z.string()),
			origin: z.enum(['builtin', 'app', 'custom']),
		})),
	}).parse(value).items
}

function asGrant(value: unknown): Pick<GrantDto, 'roleKey' | 'permissions' | 'scopeType' | 'scopeValue' | 'dangling'> {
	return z.object({
		roleKey: z.string().nullable(),
		permissions: z.array(z.string()).nullable(),
		scopeType: z.string().nullable(),
		scopeValue: z.string().nullable(),
		dangling: z.boolean(),
	}).parse(value)
}

const SCHEMA = {
	scopes: [{ type: 'organization', label: 'Organization' }, { type: 'team' }],
	actions: [
		{ action: 'project.read', description: 'Read' },
		{ action: 'project.write' },
		{ action: 'report.export' },
	],
	roles: {
		editor: { name: 'Editor', permissions: ['project.read', 'project.write'] },
		viewer: { name: 'Viewer', permissions: ['project.read'] },
	},
}

describe('PUT/GET /admin/apps/:app/schema', () => {
	test('reconciles the vocabulary and reads it back', async () => {
		const h = createHarness()
		const token = await asAdmin(h)

		const put = await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))
		expect(put.status).toBe(200)

		const get = await run(h, req('/admin/apps/opice/schema', 'GET', token))
		expect(get.status).toBe(200)
		const dto: AppSchemaDto = await get.json()
		expect(dto.app).toBe('opice')
		expect(dto.scopes.map((s) => s.type)).toEqual(['organization', 'team'])
		expect(dto.actions.map((a) => a.action)).toEqual(['project.read', 'project.write', 'report.export'])
		expect(Object.keys(dto.roles).sort()).toEqual(['editor', 'viewer'])
		expect(dto.roles['editor']?.permissions).toEqual(['project.read', 'project.write'])
	})

	test('the locale and the display name are reconciled, read back, and dropped by a schema without them', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const named = { ...SCHEMA, locale: 'cs', displayName: 'Opice' }
		expect((await run(h, req('/admin/apps/opice/schema', 'PUT', token, named))).status).toBe(200)
		const dto: AppSchemaDto = await (await run(h, req('/admin/apps/opice/schema', 'GET', token))).json()
		expect([dto.locale, dto.displayName]).toEqual(['cs', 'Opice'])
		expect((await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))).status).toBe(200)
		const dropped: AppSchemaDto = await (await run(h, req('/admin/apps/opice/schema', 'GET', token))).json()
		expect('locale' in dropped || 'displayName' in dropped).toBe(false)
	})

	test("the terminal's identification path is reconciled, read back, readable per app, and dropped by a schema without it", async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const kiosk = { ...SCHEMA, terminal: { identify: '/identify' } }
		expect((await run(h, req('/admin/apps/opice/schema', 'PUT', token, kiosk))).status).toBe(200)
		const dto: AppSchemaDto = await (await run(h, req('/admin/apps/opice/schema', 'GET', token))).json()
		expect(dto.terminal).toEqual({ identify: '/identify' })
		expect(await h.repositories.appSchema.getTerminalIdentifyPath('opice')).toBe('/identify')
		expect(await h.repositories.appSchema.getTerminalIdentifyPath('vozka')).toBeNull()
		expect((await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))).status).toBe(200)
		const dropped: AppSchemaDto = await (await run(h, req('/admin/apps/opice/schema', 'GET', token))).json()
		expect('terminal' in dropped).toBe(false)
		expect(await h.repositories.appSchema.getTerminalIdentifyPath('opice')).toBeNull()
	})

	test('an identification path that is not an absolute path on the app origin is refused', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		for (const identify of ['https://evil.test/identify', '//evil.test', '/identify?x=1', '/__fabrika/x']) {
			const put = await run(h, req('/admin/apps/opice/schema', 'PUT', token, { ...SCHEMA, terminal: { identify } }))
			expect(put.status).toBe(400)
			expect(await put.text()).toContain("the terminal's identification path")
		}
		expect((await run(h, req('/admin/apps/opice/schema', 'PUT', token, { ...SCHEMA, terminal: {} }))).status).toBe(400)
		expect(await h.repositories.appSchema.getTerminalIdentifyPath('opice')).toBeNull()
	})

	test('an app with a terminal keeps its membership transport key, which its identifications travel on', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const now = Math.floor(Date.now() / 1000)
		await h.repositories.membershipTransport.issue({ app: 'opice', keyHash: 'h1', expiresAt: now + 3600, keep: null, now })
		expect((await run(h, req('/admin/apps/opice/schema', 'PUT', token, { ...SCHEMA, terminal: { identify: '/identify' } }))).status).toBe(200)
		expect(await h.repositories.membershipTransport.appOfKey('h1', now)).toBe('opice')
		expect((await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))).status).toBe(200)
		expect(await h.repositories.membershipTransport.appOfKey('h1', now)).toBeNull()
	})

	test("the app list carries each app display name, null for an app that declares none, and whether it is the installation's own", async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		expect((await run(h, req('/admin/apps/opice/schema', 'PUT', token, { ...SCHEMA, displayName: 'Opice' }))).status).toBe(200)
		expect((await run(h, req('/admin/apps/bare/schema', 'PUT', token, SCHEMA))).status).toBe(200)
		expect((await run(h, req('/admin/apps/vozka/schema', 'PUT', token, SCHEMA))).status).toBe(200)
		const apps = await result(
			h,
			token,
			'apps.list',
			null,
			(value) =>
				z.object({ items: z.array(z.object({ id: z.string(), displayName: z.string().nullable(), installation: z.boolean() }).strict()) }).parse(value)
					.items,
		)
		expect(apps.filter((app) => ['opice', 'bare', 'vozka'].includes(app.id))).toEqual([
			{ id: 'bare', displayName: null, installation: false },
			{ id: 'opice', displayName: 'Opice', installation: false },
			{ id: 'vozka', displayName: null, installation: true },
		])
	})

	test('a locale IAM does not speak and a display name of two lines are refused, naming the field (400)', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const locale = await run(h, req('/admin/apps/opice/schema', 'PUT', token, { ...SCHEMA, locale: 'de' }))
		expect(locale.status).toBe(400)
		const localeBody: { error: string } = await locale.json()
		expect(localeBody.error).toBe("locale must be one of 'en', 'cs'")
		const name = await run(h, req('/admin/apps/opice/schema', 'PUT', token, { ...SCHEMA, displayName: 'Opice\nBcc: x' }))
		expect(name.status).toBe(400)
		const nameBody: { error: string } = await name.json()
		expect(nameBody.error).toBe('the display name contains a control character')
	})

	test('rejects a schema whose role references an unknown action (400)', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const bad = {
			scopes: [],
			actions: [{ action: 'project.read' }],
			roles: { editor: { name: 'Editor', permissions: ['project.delete'] } }, // project.delete not in catalog
		}
		const res = await run(h, req('/admin/apps/opice/schema', 'PUT', token, bad))
		expect(res.status).toBe(400)
		const body: { error: string } = await res.json()
		expect(body.error).toContain('project.delete')
	})

	test('a prefix wildcard is valid iff the namespace is non-empty', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		// 'report.*' is allowed because the catalog has 'report.export' under it.
		const ok = await run(
			h,
			req('/admin/apps/opice/schema', 'PUT', token, {
				scopes: [],
				actions: [{ action: 'report.export' }],
				roles: { exporter: { name: 'Exporter', permissions: ['report.*'] } },
			}),
		)
		expect(ok.status).toBe(200)
		// 'ghost.*' is rejected — no catalog action under that namespace.
		const bad = await run(
			h,
			req('/admin/apps/opice/schema', 'PUT', token, {
				scopes: [],
				actions: [{ action: 'report.export' }],
				roles: { ghost: { name: 'Ghost', permissions: ['ghost.*'] } },
			}),
		)
		expect(bad.status).toBe(400)
	})

	test('an unmatched /admin/* path is 404, not a second administration API', async () => {
		// The REST surface is CLOSED: four provisioning operations. Everything an operator does is
		// `/admin/rpc`, so there is no second place a gate can be forgotten or an error can leak.
		const h = createHarness()
		const token = await asAdmin(h)
		for (const path of ['/admin/me', '/admin/principals', '/admin/roles', '/admin/audit', '/admin/apps']) {
			expect((await run(h, req(path, 'GET', token))).status).toBe(404)
		}
		expect((await run(h, req('/admin/apps/opice/policies', 'GET', token))).status).toBe(404)
		expect((await run(h, req('/admin/api-keys', 'GET', token))).status).toBe(405)
	})

	test('a reconcile that COLLIDES with a custom policy is refused, loudly', async () => {
		// One-directional before this: `createPolicy` 409s on an existing key so an admin can never clobber
		// an app role, but a deploy silently flipped a custom policy to origin='app' — after which update
		// and delete both 404 and the policy is unmanageable (SEC-3).
		const h = createHarness()
		const token = await asAdmin(h)
		await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))
		await result(
			h,
			token,
			'policies.create',
			{ app: 'opice', policy: { key: 'auditor', name: 'Auditor', permissions: ['project.read', 'report.export'] } },
			(value) => value,
		)

		const collision = await run(
			h,
			req('/admin/apps/opice/schema', 'PUT', token, {
				...SCHEMA,
				roles: { ...SCHEMA.roles, auditor: { name: 'App auditor', permissions: ['project.read'] } },
			}),
		)
		expect(collision.status).toBe(409)
		expect(await collision.text()).toContain('auditor')

		// And nothing was written: the policy keeps its permissions, its name and its origin.
		const policies = await result(h, token, 'policies.list', { app: 'opice' }, asPolicies)
		expect(policies).toHaveLength(1)
		expect(policies[0]?.name).toBe('Auditor')
		expect(policies[0]?.permissions).toEqual(['project.read', 'report.export'])
	})

	test('reconcile preserves custom policies and prunes absent app roles', async () => {
		const h = createHarness()
		const token = await asAdmin(h)

		await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))

		// Compose a custom policy.
		await result(
			h,
			token,
			'policies.create',
			{ app: 'opice', policy: { key: 'auditor', name: 'Auditor', permissions: ['project.read', 'report.export'] } },
			(value) => value,
		)

		// Re-reconcile WITHOUT 'editor' (drops it) — and keep 'viewer'.
		await run(
			h,
			req('/admin/apps/opice/schema', 'PUT', token, {
				...SCHEMA,
				roles: { viewer: { name: 'Viewer', permissions: ['project.read'] } },
			}),
		)

		const schema: AppSchemaDto = await (await run(h, req('/admin/apps/opice/schema', 'GET', token))).json()
		expect(Object.keys(schema.roles)).toEqual(['viewer']) // editor pruned

		// The custom policy is untouched.
		const policies = await result(h, token, 'policies.list', { app: 'opice' }, asPolicies)
		expect(policies.map((p) => p.key)).toEqual(['auditor'])
		expect(policies[0]?.permissions).toEqual(['project.read', 'report.export'])
	})

	test('a not-yet-registered app reconciles its schema (first reconcile = registration)', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const res = await run(h, req('/admin/apps/newapp/schema', 'PUT', token, SCHEMA))
		expect(res.status).toBe(200)
	})
})

describe('policy CRUD validates against the action catalog', () => {
	test('create rejects an unknown action pattern (400); update + delete work', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))

		await failure(h, token, 'policies.create', { app: 'opice', policy: { key: 'p1', name: 'P1', permissions: ['nope.read'] } }, 400)
		await result(h, token, 'policies.create', { app: 'opice', policy: { key: 'p1', name: 'P1', permissions: ['project.read'] } }, (value) => value)

		// Update broadens the policy; validated against the catalog again.
		const updated = await result(
			h,
			token,
			'policies.update',
			{ app: 'opice', key: 'p1', policy: { name: 'P1', permissions: ['project.read', 'project.write'] } },
			(value) => asPolicies({ items: [value] })[0],
		)
		expect(updated?.permissions).toEqual(['project.read', 'project.write'])

		await result(h, token, 'policies.delete', { app: 'opice', key: 'p1' }, (value) => value)
		expect(await result(h, token, 'policies.list', { app: 'opice' }, asPolicies)).toHaveLength(0)
	})

	test('a policy cannot reuse the reserved built-in `admin` key', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))
		await failure(h, token, 'policies.create', { app: 'opice', policy: { key: 'admin', name: 'X', permissions: ['project.read'] } }, 400)
	})

	test('cannot update or delete an origin=app role via the policy endpoints', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))
		// 'editor' is an origin='app' role — the policy endpoints only manage 'custom'.
		await failure(h, token, 'policies.update', { app: 'opice', key: 'editor', policy: { name: 'Editor', permissions: ['project.read'] } }, 404)
		await failure(h, token, 'policies.delete', { app: 'opice', key: 'editor' }, 404)
	})
})

describe('grant create — role XOR inline, catalog validation, scope both-or-neither', () => {
	function targetPrincipal(h: Harness): string {
		return seedUser(h.sqlite, { sub: 'sub-target', email: 'target@example.com' })
	}

	// Register 'opice' in the DB-derived app registry (so `appField`/`knownApps` accept it) without a
	// full schema reconcile — for the tests below that grant against 'opice' but don't PUT its schema.
	function registerOpice(h: Harness): void {
		seedAppAction(h.sqlite, 'opice', 'report.read')
	}

	test('a role grant against an app role succeeds and reflects the role', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))
		const principalId = targetPrincipal(h)

		const grant = await result(h, token, 'grants.create', { principalId, app: 'opice', roleKey: 'editor' }, asGrant)
		expect(grant.roleKey).toBe('editor')
		expect(grant.permissions).toBeNull()
		expect(grant.dangling).toBe(false)
	})

	test('the built-in admin role is grantable for any app', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		registerOpice(h)
		const principalId = targetPrincipal(h)
		await result(h, token, 'grants.create', { principalId, app: 'opice', roleKey: 'admin' }, asGrant)
	})

	test('an unknown role is rejected (400)', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		registerOpice(h)
		const principalId = targetPrincipal(h)
		await failure(h, token, 'grants.create', { principalId, app: 'opice', roleKey: 'ghost' }, 400)
	})

	test('a CROSS-APP inline grant validates against the union of every registered catalog', async () => {
		// A cross-app grant has no single catalog, and substituting an empty one refused everything except
		// `*` — so an operator who wanted `deploy.read` everywhere had to grant everything instead
		// (CORR-10). The union is the right comparison, and it is a TYPO CHECK: `permits()` matches
		// patterns at request time and never pre-expands them, so an app registered later is covered by a
		// grant written today whatever this check said.
		const h = createHarness()
		const token = await asAdmin(h)
		await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))
		await run(
			h,
			req('/admin/apps/reports/schema', 'PUT', token, {
				scopes: [],
				actions: [{ action: 'deploy.read' }],
				roles: {},
			}),
		)
		const principalId = targetPrincipal(h)

		// Declared by ANOTHER app than the one it happens to be listed under — cross-app means both.
		for (const pattern of ['report.export', 'deploy.read', '*']) {
			await result(h, token, 'grants.create', { principalId, app: null, permissions: [pattern] }, asGrant)
		}

		// A typo is still a typo, and the message says what the check is.
		const message = await failure(h, token, 'grants.create', { principalId, app: null, permissions: ['deploy.raed'] }, 400)
		expect(message).toContain('not a security boundary')
	})

	test('an inline grant validates each pattern against the app catalog', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))
		const principalId = targetPrincipal(h)

		const grant = await result(h, token, 'grants.create', { principalId, app: 'opice', permissions: ['report.export'] }, asGrant)
		expect(grant.roleKey).toBeNull()
		expect(grant.permissions).toEqual(['report.export'])

		await failure(h, token, 'grants.create', { principalId, app: 'opice', permissions: ['project.delete'] }, 400)
	})

	test('supplying BOTH roleKey and permissions is rejected (XOR)', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))
		const principalId = targetPrincipal(h)
		await failure(h, token, 'grants.create', { principalId, app: 'opice', roleKey: 'editor', permissions: ['report.export'] }, 400)
	})

	test('supplying NEITHER roleKey nor permissions is rejected (XOR)', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		registerOpice(h)
		const principalId = targetPrincipal(h)
		await failure(h, token, 'grants.create', { principalId, app: 'opice' }, 400)
	})

	test('a half-set scope (scopeType without scopeValue) is rejected (400)', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		registerOpice(h)
		const principalId = targetPrincipal(h)
		await failure(h, token, 'grants.create', { principalId, app: 'opice', roleKey: 'admin', scopeType: 'team' }, 400)
	})

	test('a full scope coordinate is accepted and reflected', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		registerOpice(h)
		const principalId = targetPrincipal(h)
		const grant = await result(
			h,
			token,
			'grants.create',
			{ principalId, app: 'opice', roleKey: 'admin', scopeType: 'team', scopeValue: 'acme' },
			asGrant,
		)
		expect(grant.scopeType).toBe('team')
		expect(grant.scopeValue).toBe('acme')
	})
})

describe('roles.list is app-aware (built-ins + the app DB roles)', () => {
	test('lists built-in admin plus the app roles for app=opice', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		await run(h, req('/admin/apps/opice/schema', 'PUT', token, SCHEMA))
		const roles = await result(h, token, 'roles.list', { app: 'opice' }, asRoles)
		const byKey = new Map(roles.map((r) => [r.key, r]))
		expect(byKey.get('admin')?.origin).toBe('builtin')
		expect(byKey.get('editor')?.origin).toBe('app')
		expect(byKey.get('viewer')?.origin).toBe('app')
	})

	test('without an app only the built-ins are listed', async () => {
		const h = createHarness()
		const token = await asAdmin(h)
		const roles = await result(h, token, 'roles.list', { app: null }, asRoles)
		expect(roles.map((r) => r.key)).toEqual(['admin'])
	})
})
