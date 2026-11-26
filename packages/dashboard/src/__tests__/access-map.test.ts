import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
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
	creatorOf: ['org'],
	external: false,
	actions: ['notes.read', 'notes.write'],
	via: [],
}
const ADMIN: AccessMapRoleDto = {
	role: 'admin',
	scope: null,
	assignableBy: [],
	creatorOf: [],
	external: true,
	actions: ['notes.read'],
	via: [{
		relation: 'note_reviewers',
		dimension: 'note',
		actions: ['notes.read'],
		conferredBy: ['a row of reviews naming user_id at note_id; no handler inserts one'],
	}],
}
const READ: AccessMapActionDto = {
	action: 'notes.read',
	description: 'Read notes',
	endpoints: Array.from(
		{ length: 10 },
		(_, index) => ({ id: `api.get${index}`, method: 'POST', path: `/api/get${index}`, access: 'on note', callers: ['human', 'machine'] }),
	),
	members: [],
	links: ['issue share links of shared to a note, which grant notes.read'],
	tables: [{
		table: 'notes',
		lies: 'one row per note, inside its org',
		operations: ['read'],
		also: ['a read over a project also reaches the rows its project_id names'],
	}],
	files: ['read the files of attachments (rows of notes)'],
}
const WRITE: AccessMapActionDto = { action: 'notes.write', description: '', endpoints: [], members: [], links: [], tables: [], files: [] }
const MAP: AccessMapDto = {
	roles: [EDITOR, ADMIN],
	actions: [READ, WRITE],
	memberEndpoints: [{ id: 'api.me', method: 'POST', path: '/api/me', access: 'any member', callers: ['human'] }],
}

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

// The real route of the people page, so the link to who holds the roles resolves to the path the console serves.
const section = (env: AppEnvDto, people = false): string =>
	renderToStaticMarkup(createElement(BuzolaProvider, {
		router: new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry: { people: '/people' },
		}),
	}, createElement(AccessMapSection, { env, people })))

describe('the access map in the console', () => {
	test('a role says where it is granted, who assigns it and how many actions it holds', () => {
		expect(roleSummary(EDITOR)).toBe('in each org, assigned by owner and to the creator of each new org · 2 actions')
		expect(roleSummary(ADMIN)).toBe('app-wide, granted globally, external people too · 1 action')
	})

	test('each action of a role lists its endpoints, the tables it reaches and the links it issues', () => {
		const html = section(environment('prod', MAP))
		expect(html).toContain('<h2>Roles</h2>')
		expect(html).toContain('<code>notes.read</code>')
		expect(html).toContain('Read notes')
		expect(html).toContain('<code>POST /api/get0</code>')
		expect(html).toContain('<code>notes</code> read')
		expect(html).toContain('one row per note, inside its org')
		expect(html).toContain('issue share links of shared to a note, which grant notes.read')
		expect(html).toContain('through relation note_reviewers, where its row names them')
		expect(html).toContain('conferred by a row of reviews naming user_id at note_id; no handler inserts one')
		expect(html).toContain('a read over a project also reaches the rows its project_id names')
		expect(html).toContain('read the files of attachments (rows of notes)')
		expect(html).toContain('on note · people, scripts')
	})

	test('an action with more than eight endpoints folds the rest under a count', () => {
		const html = section(environment('prod', MAP))
		expect(html).toContain('2 more</summary>')
		expect(html.indexOf('/api/get7')).toBeLessThan(html.indexOf('2 more'))
		expect(html.indexOf('/api/get8')).toBeGreaterThan(html.indexOf('2 more'))
	})

	test('the endpoints any member reaches are listed once, beside the roles', () => {
		const html = section(environment('prod', MAP))
		expect(html).toContain('every member')
		expect(html).toContain('<code>POST /api/me</code>')
	})

	test('before a publication, or from a Control that does not send the map, the environment says it has no roles yet', () => {
		expect(section(environment('prod', { roles: [], actions: [], memberEndpoints: [] }))).toContain('No roles are published on prod yet.')
		expect(section(environment('dev', undefined))).toContain('No roles are published on dev yet.')
	})

	test('who holds the roles links to the people of that environment, for a caller who administers people', () => {
		expect(section(environment('prod', MAP), true)).toContain('<a href="/people?app=notes%40prod">Who holds them</a>')
		expect(section(environment('prod', MAP), false)).not.toContain('Who holds them')
	})
})
