import type { PermissionEntry, RoleDef, Scope } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import type { GrantRow } from '../db'
import { authorityDeadline, computeAuthority, computePermissions, type ResolutionInputs } from '../resolve'
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

const base: ResolutionInputs = { app: APP, grants: [], isBootstrapAdmin: false, affiliation: 'internal' }

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
			{ app: APP, grants: [roleGrant('admin', null)], isBootstrapAdmin: false, affiliation: 'internal' },
			emptyRoles,
		)
		expect(entries).toEqual([{ action: '*', scope: null, source: 'grant' }])
	})

	test('admin resolves at app=null (cross-app) too', () => {
		const emptyRoles = makeRoleSource({})
		const adminGrant: GrantRow = { ...roleGrant('admin', null), app: null }
		const entries = computePermissions(
			{ app: null, grants: [adminGrant], isBootstrapAdmin: false, affiliation: 'internal' },
			emptyRoles,
		)
		expect(entries).toEqual([{ action: '*', scope: null, source: 'grant' }])
	})

	test('an app role unknown to the loaded source is dangling (fail-closed)', () => {
		// `viewer` lives in APP_ROLES; an empty source must not resolve it.
		const emptyRoles = makeRoleSource({})
		const entries = computePermissions(
			{ app: APP, grants: [roleGrant('viewer', null)], isBootstrapAdmin: false, affiliation: 'internal' },
			emptyRoles,
		)
		expect(entries).toEqual([])
	})
})

describe('computePermissions — bootstrap', () => {
	test('bootstrap admin unions a global admin role with source bootstrap', () => {
		const entries = computePermissions({ ...base, isBootstrapAdmin: true, affiliation: 'internal' }, roles)
		expect(entries).toEqual([{ action: '*', scope: null, source: 'bootstrap' }])
	})

	test('unions grants and bootstrap', () => {
		const entries = computePermissions(
			{ app: APP, grants: [roleGrant('viewer', TEAM('acme'))], isBootstrapAdmin: true, affiliation: 'internal' },
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
		const entries = computePermissions({ ...base, grants: [roleGrant('admin', null)], isBootstrapAdmin: true, affiliation: 'internal' }, roles)
		expect(has(entries, '*', null, 'grant')).toBe(true)
		expect(has(entries, '*', null, 'bootstrap')).toBe(true)
	})

	test('no sources → empty', () => {
		expect(computePermissions(base, roles)).toEqual([])
	})
})

describe('computePermissions — membership roles', () => {
	const memberRoles = makeRoleSource({ owner: { name: 'Owner', permissions: ['project.read'], member: { scope: 'team' } } })

	test('a grant in a value of its own dimension resolves', () => {
		const entries = computePermissions({ ...base, grants: [roleGrant('owner', TEAM('acme'))] }, memberRoles)
		expect(entries).toEqual([{ action: 'project.read', scope: TEAM('acme'), source: 'grant' }])
	})

	test('a global grant, or one in another dimension, contributes nothing (fail-closed)', () => {
		expect(computePermissions({ ...base, grants: [roleGrant('owner', null)] }, memberRoles)).toEqual([])
		expect(computePermissions({ ...base, grants: [roleGrant('owner', { type: 'workspace', value: 'w' })] }, memberRoles)).toEqual([])
	})
})

describe('computePermissions — an external principal (ADR-0051)', () => {
	const externalRoles = makeRoleSource({
		partner: { name: 'Partner', permissions: ['project.read'], member: { scope: 'team' }, external: true },
		owner: { name: 'Owner', permissions: ['project.read', 'project.write'], member: { scope: 'team' } },
	})
	const external: ResolutionInputs = { ...base, affiliation: 'external' }

	test('a grant of a role declared external resolves; any other role, inline or built-in grant contributes nothing', () => {
		const grants = [
			roleGrant('partner', TEAM('acme')),
			roleGrant('owner', TEAM('acme')),
			roleGrant('admin', null),
			inlineGrant(['project.write'], TEAM('acme')),
		]
		expect(computePermissions({ ...external, grants }, externalRoles)).toEqual([{ action: 'project.read', scope: TEAM('acme'), source: 'grant' }])
	})

	test('a cross-app grant and the bootstrap admin reach no external principal', () => {
		const crossApp = { ...roleGrant('partner', TEAM('acme')), app: null }
		expect(computePermissions({ ...external, grants: [crossApp], isBootstrapAdmin: true }, externalRoles)).toEqual([])
	})

	test('an internal principal holds an external role like any other', () => {
		const entries = computePermissions({ ...base, grants: [roleGrant('partner', TEAM('acme')), roleGrant('owner', TEAM('acme'))] }, externalRoles)
		expect(entries.map((entry) => entry.action).sort()).toEqual(['project.read', 'project.write'])
	})
})

describe('authorityDeadline — a credential never outlives the grants it carries', () => {
	const NOW = 1_000
	const expiring = (grant: GrantRow, expiresAt: number | null): GrantRow => ({ ...grant, id: `${grant.id}-${expiresAt}`, expires_at: expiresAt })

	test('per entry the latest supporting grant counts, then the earliest across entries', () => {
		const authority = computeAuthority({
			...base,
			grants: [
				expiring(inlineGrant(['project.read'], null), 2_000),
				expiring(inlineGrant(['project.read'], null), 5_000),
				expiring(inlineGrant(['report.read'], null), 3_000),
			],
		}, roles)
		expect(authorityDeadline(authority, authority.permissions, NOW)).toBe(3_000)
	})

	test('a grant without expiry is no deadline, also beside an expiring grant of the same entry', () => {
		const authority = computeAuthority({
			...base,
			grants: [expiring(inlineGrant(['project.read'], null), 2_000), expiring(roleGrant('viewer', null), null)],
		}, roles)
		expect(authorityDeadline(authority, authority.permissions, NOW)).toBeNull()
	})

	test('a covering global grant supports a scoped entry; an uncovered expiring one still caps', () => {
		const authority = computeAuthority({
			...base,
			grants: [expiring(inlineGrant(['project.read'], TEAM('acme')), 2_000), expiring(inlineGrant(['project.*'], null), 4_000)],
		}, roles)
		expect(authorityDeadline(authority, [{ action: 'project.read', scope: TEAM('acme'), source: 'grant' }], NOW)).toBe(4_000)
		expect(authorityDeadline(authority, authority.permissions, NOW)).toBe(4_000)
		const scopedOnly = computeAuthority({ ...base, grants: [expiring(inlineGrant(['project.read'], TEAM('acme')), 2_000)] }, roles)
		expect(authorityDeadline(scopedOnly, scopedOnly.permissions, NOW)).toBe(2_000)
	})

	test('an entry nothing supports gives the deadline now', () => {
		const authority = computeAuthority({ ...base, grants: [] }, roles)
		expect(authorityDeadline(authority, [{ action: 'project.read', scope: null, source: 'grant' }], NOW)).toBe(NOW)
	})
})

describe('computePermissions — a contract application holds exact actions only', () => {
	test('a pattern, inline or through a role, contributes nothing; exact actions stay', () => {
		const grants = [roleGrant('editor', null), roleGrant('viewer', null), inlineGrant(['report.*', 'report.export'], null)]
		const entries = computePermissions({ ...base, grants, exactActions: true }, roles)
		expect(entries.map((entry) => entry.action).sort()).toEqual(['project.read', 'report.export', 'report.read'])
	})

	test('the built-in admin grants nothing there', () => {
		expect(computePermissions({ ...base, grants: [roleGrant('admin', null)], exactActions: true }, roles)).toEqual([])
		expect(computePermissions({ ...base, grants: [roleGrant('admin', null)] }, roles)).toHaveLength(1)
	})
})
