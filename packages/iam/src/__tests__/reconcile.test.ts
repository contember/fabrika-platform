import { describe, expect, test } from 'bun:test'
import { createHarness } from './helpers/harness'

// The app-schema reconcile contract (db.reconcileAppSchema), driven through the real
// `Db` over the production migration. The load-bearing properties:
//   - it's idempotent and additive-then-pruning: a second reconcile with fewer items
//     removes the absent origin='app' rows;
//   - origin='custom' policies are NEVER touched by a reconcile (admin-composed
//     policies survive a redeploy that drops the app role they happen to share a key
//     space with);
//   - scopes/actions reconcile the same way (upsert + prune by the incoming set).

describe('Db.reconcileAppSchema', () => {
	test('upserts scopes, actions and origin=app roles, then prunes absent ones', async () => {
		const h = createHarness()
		const app = 'opice'

		await h.repositories.appSchema.reconcileAppSchema({
			app,
			scopes: [{ scopeType: 'organization', label: 'Organization' }, { scopeType: 'team', label: null }],
			actions: [{ action: 'project.read', description: null }, { action: 'project.write', description: 'Edit' }],
			roles: [{ roleKey: 'editor', name: 'Editor', description: null, permissions: ['project.read', 'project.write'] }],
		})

		expect((await h.repositories.appSchema.listAppScopes(app)).map((s) => s.scope_type)).toEqual(['organization', 'team'])
		expect(await h.repositories.appSchema.listActionCatalog(app)).toEqual(['project.read', 'project.write'])
		expect((await h.repositories.appSchema.listRolesByOrigin(app, 'app')).map((r) => r.role_key)).toEqual(['editor'])

		// Second reconcile: drop the 'team' scope, the 'project.write' action and add a
		// 'viewer' role while removing 'editor'. The absent origin='app' rows are pruned.
		await h.repositories.appSchema.reconcileAppSchema({
			app,
			scopes: [{ scopeType: 'organization', label: 'Org (renamed)' }],
			actions: [{ action: 'project.read', description: null }],
			roles: [{ roleKey: 'viewer', name: 'Viewer', description: null, permissions: ['project.read'] }],
		})

		expect((await h.repositories.appSchema.listAppScopes(app)).map((s) => s.scope_type)).toEqual(['organization'])
		// The label was updated in place (upsert), not duplicated.
		expect((await h.repositories.appSchema.listAppScopes(app))[0]?.label).toBe('Org (renamed)')
		expect(await h.repositories.appSchema.listActionCatalog(app)).toEqual(['project.read'])
		expect((await h.repositories.appSchema.listRolesByOrigin(app, 'app')).map((r) => r.role_key)).toEqual(['viewer'])
	})

	test('a reconcile NEVER touches origin=custom policies', async () => {
		const h = createHarness()
		const app = 'opice'

		// First reconcile seeds the action catalog + an app role.
		await h.repositories.appSchema.reconcileAppSchema({
			app,
			scopes: [],
			actions: [{ action: 'report.read', description: null }, { action: 'report.export', description: null }],
			roles: [{ roleKey: 'editor', name: 'Editor', description: null, permissions: ['report.read'] }],
		})

		// An admin composes a custom policy (origin='custom').
		await h.repositories.appSchema.upsertRole({
			app,
			roleKey: 'auditor',
			name: 'Auditor',
			description: 'Read + export',
			permissions: ['report.read', 'report.export'],
			origin: 'custom',
		})

		// A second reconcile that drops the 'editor' app role entirely. The custom
		// 'auditor' policy must survive untouched.
		await h.repositories.appSchema.reconcileAppSchema({
			app,
			scopes: [],
			actions: [{ action: 'report.read', description: null }, { action: 'report.export', description: null }],
			roles: [],
		})

		expect((await h.repositories.appSchema.listRolesByOrigin(app, 'app')).map((r) => r.role_key)).toEqual([])
		const custom = await h.repositories.appSchema.listRolesByOrigin(app, 'custom')
		expect(custom.map((r) => r.role_key)).toEqual(['auditor'])
		const auditor = await h.repositories.appSchema.getRole(app, 'auditor')
		expect(auditor?.origin).toBe('custom')
		expect(auditor?.name).toBe('Auditor')
	})

	test('a COLLIDING custom policy keeps its permissions, name and origin', async () => {
		// The case `reconcile.test.ts` never covered and the one that was broken: an app declaring a role
		// key an admin already owns as a custom policy. The upsert flipped it to origin='app' and
		// overwrote its permissions — after which update and delete both require origin='custom' and
		// 404, so the policy became unmanageable (SEC-3). The admin surface now refuses that reconcile
		// outright; this is the layer below it, where a collision must be a no-op rather than a rewrite.
		const h = createHarness()
		const app = 'opice'

		await h.repositories.appSchema.reconcileAppSchema({
			app,
			scopes: [],
			actions: [{ action: 'report.read', description: null }, { action: 'report.export', description: null }],
			roles: [],
		})
		await h.repositories.appSchema.upsertRole({
			app,
			roleKey: 'auditor',
			name: 'Auditor',
			description: 'Read + export',
			permissions: ['report.read', 'report.export'],
			origin: 'custom',
		})

		await h.repositories.appSchema.reconcileAppSchema({
			app,
			scopes: [],
			actions: [{ action: 'report.read', description: null }, { action: 'report.export', description: null }],
			roles: [{ roleKey: 'auditor', name: 'App auditor', description: 'from code', permissions: ['report.read'] }],
		})

		const auditor = await h.repositories.appSchema.getRole(app, 'auditor')
		expect(auditor?.origin).toBe('custom')
		expect(auditor?.name).toBe('Auditor')
		expect(auditor?.description).toBe('Read + export')
		expect(auditor?.permissions).toBe(JSON.stringify(['report.read', 'report.export']))
		// And the app did NOT gain a role it thinks it declared.
		expect(await h.repositories.appSchema.listRolesByOrigin(app, 'app')).toEqual([])
	})

	test('the prune statement width does not grow with the catalog', async () => {
		// D1 allows 100 bound parameters per query. The old prune put one per KEPT value into a single
		// `NOT IN (...)`, so an app with a hundred actions could not reconcile at all (CORR-9).
		const h = createHarness()
		const app = 'wide'
		const actions = Array.from({ length: 250 }, (_, i) => ({ action: `action.n${i}`, description: null }))

		await h.repositories.appSchema.reconcileAppSchema({ app, scopes: [], actions, roles: [] })
		expect(await h.repositories.appSchema.listActionCatalog(app)).toHaveLength(250)

		await h.repositories.appSchema.reconcileAppSchema({ app, scopes: [], actions: actions.slice(0, 3), roles: [] })
		expect((await h.repositories.appSchema.listActionCatalog(app)).sort()).toEqual(['action.n0', 'action.n1', 'action.n2'])
	})

	test('reconciling with empty sets prunes all the app rows (but not custom policies)', async () => {
		const h = createHarness()
		const app = 'poplach'

		await h.repositories.appSchema.reconcileAppSchema({
			app,
			scopes: [{ scopeType: 'project', label: null }],
			actions: [{ action: 'project.read', description: null }],
			roles: [{ roleKey: 'editor', name: 'Editor', description: null, permissions: ['project.read'] }],
		})
		await h.repositories.appSchema.upsertRole({ app, roleKey: 'custom1', name: 'C1', permissions: ['project.read'], origin: 'custom' })

		await h.repositories.appSchema.reconcileAppSchema({ app, scopes: [], actions: [], roles: [] })

		expect(await h.repositories.appSchema.listAppScopes(app)).toHaveLength(0)
		expect(await h.repositories.appSchema.listActionCatalog(app)).toHaveLength(0)
		expect(await h.repositories.appSchema.listRolesByOrigin(app, 'app')).toHaveLength(0)
		// The custom policy is preserved even though its permissions now reference an
		// action no longer in the catalog (validation is at write time, not prune time).
		expect((await h.repositories.appSchema.listRolesByOrigin(app, 'custom')).map((r) => r.role_key)).toEqual(['custom1'])
	})

	test('an app role is isolated to its app (no cross-app bleed)', async () => {
		const h = createHarness()
		await h.repositories.appSchema.reconcileAppSchema({
			app: 'opice',
			scopes: [],
			actions: [{ action: 'a.read', description: null }],
			roles: [{ roleKey: 'editor', name: 'Editor', description: null, permissions: ['a.read'] }],
		})
		// A different app's reconcile leaves opice's roles intact.
		await h.repositories.appSchema.reconcileAppSchema({
			app: 'poplach',
			scopes: [],
			actions: [{ action: 'b.read', description: null }],
			roles: [{ roleKey: 'editor', name: 'Editor', description: null, permissions: ['b.read'] }],
		})
		expect((await h.repositories.appSchema.listRoles('opice')).map((r) => r.role_key)).toEqual(['editor'])
		expect((await h.repositories.appSchema.getRole('opice', 'editor'))?.permissions).toBe(JSON.stringify(['a.read']))
		expect((await h.repositories.appSchema.getRole('poplach', 'editor'))?.permissions).toBe(JSON.stringify(['b.read']))
	})
})
