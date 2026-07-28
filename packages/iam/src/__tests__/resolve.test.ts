import type { PermissionEntry, RoleDef, Scope } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import type { GrantRow } from '../db'
import { computePermissions, type ResolutionInputs } from '../resolve'
import { makeRoleSource } from '../roles'

// computePermissions is PURE: it takes already-fetched rows plus an app-aware
// RoleSource (built-ins layered over the calling app's DB roles, loaded up front).
// These tests build that RoleSource from an in-memory role map and assert the union /
// expansion / dedup behavior across role grants, inline grants and bootstrap.

const APP = 'opice'

// The app's DB roles for this suite (what the worker loads from the `roles` table).
const APP_ROLES: Record<string, RoleDef> = {
	editor: { name: 'Editor', permissions: ['project.*', 'report.*'] },
	viewer: { name: 'Viewer', permissions: ['project.read', 'report.read'] },
}

const roles = makeRoleSource(APP_ROLES)

const roleGrant = (roleKey: string, scope: Scope | null): GrantRow => ({
	id: `g-${roleKey}-${scope ? `${scope.type}:${scope.value}` : 'global'}`,
	principal_id: 'p1',
	app: APP,
	role_key: roleKey,
	permissions: null,
	scope_type: scope?.type ?? null,
	scope_value: scope?.value ?? null,
	granted_by: null,
	expires_at: null,
	created_at: 0,
})

const inlineGrant = (permissions: string[], scope: Scope | null): GrantRow => ({
	id: `gi-${permissions.join(',')}`,
	principal_id: 'p1',
	app: APP,
	role_key: null,
	permissions: JSON.stringify(permissions),
	scope_type: scope?.type ?? null,
	scope_value: scope?.value ?? null,
	granted_by: null,
	expires_at: null,
	created_at: 0,
})

const TEAM = (value: string): Scope => ({ type: 'team', value })

const scopeEq = (a: Scope | null, b: Scope | null): boolean => a === null ? b === null : b !== null && a.type === b.type && a.value === b.value

const has = (entries: PermissionEntry[], action: string, scope: Scope | null, source: string): boolean =>
	entries.some((e) => e.action === action && scopeEq(e.scope, scope) && e.source === source)

const base: ResolutionInputs = { app: APP, grants: [], isBootstrapAdmin: false }

describe('computePermissions — role grants', () => {
	test('expands a grant role into its permission patterns (source grant)', () => {
		const entries = computePermissions({ ...base, grants: [roleGrant('viewer', null)] }, roles)
		expect(has(entries, 'project.read', null, 'grant')).toBe(true)
		expect(has(entries, 'report.read', null, 'grant')).toBe(true)
		expect(entries).toHaveLength(2)
	})

	test('wildcard patterns stay as patterns (not pre-expanded)', () => {
		const entries = computePermissions({ ...base, grants: [roleGrant('editor', null)] }, roles)
		expect(has(entries, 'project.*', null, 'grant')).toBe(true)
		expect(has(entries, 'report.*', null, 'grant')).toBe(true)
		expect(entries).toHaveLength(2)
	})

	test('editor wildcard patterns are scoped to the grant scope', () => {
		const entries = computePermissions({ ...base, grants: [roleGrant('editor', TEAM('acme'))] }, roles)
		expect(has(entries, 'project.*', TEAM('acme'), 'grant')).toBe(true)
		expect(has(entries, 'report.*', TEAM('acme'), 'grant')).toBe(true)
	})

	test('dangling role key resolves to zero permissions (fail-closed)', () => {
		const entries = computePermissions({ ...base, grants: [roleGrant('ghost', null)] }, roles)
		expect(entries).toEqual([])
	})
})

describe('computePermissions — inline grants', () => {
	test('inline permissions are added directly as patterns with source grant', () => {
		const entries = computePermissions({ ...base, grants: [inlineGrant(['report.export', 'report.read'], TEAM('acme'))] }, roles)
		expect(has(entries, 'report.export', TEAM('acme'), 'grant')).toBe(true)
		expect(has(entries, 'report.read', TEAM('acme'), 'grant')).toBe(true)
		expect(entries).toHaveLength(2)
	})

	test('an inline wildcard pattern stays a pattern', () => {
		const entries = computePermissions({ ...base, grants: [inlineGrant(['report.*'], null)] }, roles)
		expect(entries).toEqual([{ action: 'report.*', scope: null, source: 'grant' }])
	})

	test('a role grant and an inline grant union (no role lookup for inline)', () => {
		const entries = computePermissions(
			{ ...base, grants: [roleGrant('viewer', null), inlineGrant(['report.export'], TEAM('acme'))] },
			roles,
		)
		expect(has(entries, 'project.read', null, 'grant')).toBe(true)
		expect(has(entries, 'report.export', TEAM('acme'), 'grant')).toBe(true)
	})

	test('malformed inline permissions resolve to zero permissions instead of throwing', () => {
		// The `CHECK (json_valid(permissions))` that used to make this unreachable was SQLite-only,
		// so it is gone from the migrations — which puts an unparseable row on the AUTHZ path.
		// It must fail closed, never throw: a 500 here would take down authenticate().
		const junk: GrantRow = { ...inlineGrant([], null), permissions: 'not json' }
		expect(computePermissions({ ...base, grants: [junk] }, roles)).toEqual([])

		// Valid JSON of the wrong shape is the same story, and a non-string element is dropped.
		const notAnArray: GrantRow = { ...inlineGrant([], null), permissions: '{"report.read":true}' }
		expect(computePermissions({ ...base, grants: [notAnArray] }, roles)).toEqual([])
		const mixed: GrantRow = { ...inlineGrant([], null), permissions: '["report.read", 7]' }
		expect(computePermissions({ ...base, grants: [mixed] }, roles)).toEqual([{ action: 'report.read', scope: null, source: 'grant' }])
	})
})

describe('computePermissions — built-in admin & per-app resolution', () => {
	test('the built-in admin role resolves even with no app DB roles loaded', () => {
		const emptyRoles = makeRoleSource({})
		const entries = computePermissions(
			{ app: APP, grants: [roleGrant('admin', null)], isBootstrapAdmin: false },
			emptyRoles,
		)
		expect(entries).toEqual([{ action: '*', scope: null, source: 'grant' }])
	})

	test('admin resolves at app=null (cross-app) too', () => {
		const emptyRoles = makeRoleSource({})
		const adminGrant: GrantRow = { ...roleGrant('admin', null), app: null }
		const entries = computePermissions(
			{ app: null, grants: [adminGrant], isBootstrapAdmin: false },
			emptyRoles,
		)
		expect(entries).toEqual([{ action: '*', scope: null, source: 'grant' }])
	})

	test('an app role unknown to the loaded source is dangling (fail-closed)', () => {
		// `viewer` lives in APP_ROLES; an empty source must not resolve it.
		const emptyRoles = makeRoleSource({})
		const entries = computePermissions(
			{ app: APP, grants: [roleGrant('viewer', null)], isBootstrapAdmin: false },
			emptyRoles,
		)
		expect(entries).toEqual([])
	})
})

describe('computePermissions — bootstrap', () => {
	test('bootstrap admin unions a global admin role with source bootstrap', () => {
		const entries = computePermissions({ ...base, isBootstrapAdmin: true }, roles)
		expect(entries).toEqual([{ action: '*', scope: null, source: 'bootstrap' }])
	})

	test('unions grants and bootstrap', () => {
		const entries = computePermissions(
			{ app: APP, grants: [roleGrant('viewer', TEAM('acme'))], isBootstrapAdmin: true },
			roles,
		)
		expect(has(entries, 'project.read', TEAM('acme'), 'grant')).toBe(true)
		expect(has(entries, '*', null, 'bootstrap')).toBe(true)
	})
})

describe('computePermissions — dedup', () => {
	test('dedupes identical (action, scope, source)', () => {
		const entries = computePermissions({ ...base, grants: [roleGrant('viewer', null), roleGrant('viewer', null)] }, roles)
		expect(entries).toHaveLength(2)
	})

	test('same permission from different sources is kept separately (source distinguishes)', () => {
		// A global `admin` grant (→ '*' source 'grant') plus bootstrap (→ '*' source 'bootstrap'):
		// same action+scope, different source, kept as two distinct entries.
		const entries = computePermissions({ ...base, grants: [roleGrant('admin', null)], isBootstrapAdmin: true }, roles)
		expect(has(entries, '*', null, 'grant')).toBe(true)
		expect(has(entries, '*', null, 'bootstrap')).toBe(true)
	})

	test('no sources → empty', () => {
		expect(computePermissions(base, roles)).toEqual([])
	})
})
