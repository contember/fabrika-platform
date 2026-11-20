import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { roleSummary } from '../components/AccessMap'
import { AccessMapSection } from '../components/app-detail/AccessMapSection'
import type { AccessMapActionDto, AccessMapDto, AccessMapRoleDto, AppEnvDto } from '../lib/api'

const EDITOR: AccessMapRoleDto = {
	role: 'editor',
	scope: 'org',
	assignableBy: ['owner'],
	external: false,
	actions: ['notes.read', 'notes.write'],
	via: [],
}
const ADMIN: AccessMapRoleDto = {
	role: 'admin',
	scope: null,
	assignableBy: [],
	external: true,
	actions: [],
	via: [{ relation: 'note_reviewers', dimension: 'note', actions: ['notes.read'] }],
}
const READ: AccessMapActionDto = {
	action: 'notes.read',
	description: 'Read notes',
	endpoints: Array.from({ length: 10 }, (_, index) => ({ id: `api.get${index}`, method: 'POST', path: `/api/get${index}`, access: 'on note' })),
	members: [],
	links: ['issue share links of shared to a note, which grant notes.read'],
	tables: [{ table: 'notes', lies: 'one row per note, inside its org', operations: ['read'] }],
}
const WRITE: AccessMapActionDto = { action: 'notes.write', description: '', endpoints: [], members: [], links: [], tables: [] }
const MAP: AccessMapDto = { roles: [EDITOR, ADMIN], actions: [READ, WRITE] }

const environment = (env: string, accessMap: AccessMapDto | undefined): AppEnvDto => ({
	appId: 'notes',
	env,
	domain: null,
	publicOrigin: null,
	crossOrigins: [],
	triggerRef: null,
	authoring: false,
	protected: false,
	publishedRunId: null,
	deviationSubjects: [],
	surface: [],
	...(accessMap === undefined ? {} : { accessMap }),
	namespaceId: null,
	provider: 'zerops',
	target: { provider: 'zerops', version: 1, payload: {} },
	artifact: { provider: 'zerops', version: 1, payload: {} },
	createdAt: 0,
})

const section = (envs: readonly AppEnvDto[]): string => renderToStaticMarkup(createElement(AccessMapSection, { envs }))

describe('the access map in the console', () => {
	test('a role says where it is granted, who assigns it and how many actions it holds', () => {
		expect(roleSummary(EDITOR)).toBe('in each org, assigned by owner · 2 actions')
		expect(roleSummary(ADMIN)).toBe('app-wide, granted globally, external people too · 1 action')
	})

	test('each action of a role lists its endpoints, the tables it reaches and the links it issues', () => {
		const html = section([environment('prod', MAP)])
		expect(html).toContain('Access by role')
		expect(html).toContain('<code>notes.read</code>')
		expect(html).toContain('Read notes')
		expect(html).toContain('<code>POST /api/get0</code>')
		expect(html).toContain('<code>notes</code> read')
		expect(html).toContain('one row per note, inside its org')
		expect(html).toContain('issue share links of shared to a note, which grant notes.read')
		expect(html).toContain('through note_reviewers, where its row names them')
	})

	test('an action with more than eight endpoints folds the rest under a count', () => {
		const html = section([environment('prod', MAP)])
		expect(html).toContain('2 more</summary>')
		expect(html.indexOf('/api/get7')).toBeLessThan(html.indexOf('2 more'))
		expect(html.indexOf('/api/get8')).toBeGreaterThan(html.indexOf('2 more'))
	})

	test('nothing shows before a publication, or from a Control that does not send the map', () => {
		expect(section([environment('prod', { roles: [], actions: [] }), environment('dev', undefined)])).toBe('')
	})
})
