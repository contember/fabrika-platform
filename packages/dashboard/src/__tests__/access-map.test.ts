import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import type { RpcFetch } from '@fabrika/app'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { roleSummary } from '../components/AccessMap'
import { AccessMapSection } from '../components/app-detail/AccessMapSection'
import type { AccessMapActionDto, AccessMapDto, AccessMapRoleDto, AppEnvDto } from '../lib/api'
import { readRoleHolders, type RoleHolders } from '../lib/role-holders'

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
const section = (env: AppEnvDto, people = false, holders: RoleHolders | null = null): string =>
	renderToStaticMarkup(createElement(BuzolaProvider, {
		router: new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry: { people: '/people' },
		}),
	}, createElement(AccessMapSection, { env, people, holders })))

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

	test('before a publication the environment has no roles yet; a published release without roles says so; an older Control shows nothing', () => {
		const empty = { roles: [], actions: [], memberEndpoints: [] }
		expect(section(environment('prod', empty))).toContain('No roles are published on prod yet.')
		expect(section({ ...environment('prod', empty), publishedRunId: 'run-1' })).toContain('The release published on prod declares no roles.')
		expect(section(environment('dev', undefined))).toBe('')
	})

	test('who holds the roles links to the people of that environment, for a caller who administers people', () => {
		expect(section(environment('prod', MAP), true)).toContain('<a href="/people?app=notes%40prod">Who holds them</a>')
		expect(section(environment('prod', MAP), false)).not.toContain('Who holds them')
	})

	test('each role says how many hold it when IAM counted them, and nothing about holders when it did not', () => {
		const html = section(environment('prod', MAP), true, new Map([['editor', 3]]))
		expect(html).toContain('<span class="muted">3 holders</span>')
		expect(html).toContain('<span class="muted">no holders</span>')
		expect(section(environment('prod', MAP), true, new Map([['editor', 1], ['admin', 2]]))).toContain('<span class="muted">1 holder</span>')
		expect(section(environment('prod', MAP), true)).not.toContain('holder')
	})
})

describe('reading the holders of each role', () => {
	const calls: unknown[] = []
	const answering = (response: () => Response): RpcFetch => async (_input, init) => {
		calls.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null)
		return response()
	}

	test('one IAM read answers every role of the environment', async () => {
		calls.length = 0
		const holders = await readRoleHolders(
			'notes@prod',
			answering(() => Response.json({ result: { app: 'notes@prod', roles: [{ role: 'editor', holders: 3 }, { role: 'admin', holders: 1 }] } })),
		)
		expect(holders === null ? null : [...holders]).toEqual([['editor', 3], ['admin', 1]])
		expect(calls).toEqual([{ method: 'appPeople.holders', input: { app: 'notes@prod' } }])
	})

	test('is null when IAM refuses or is down, so the roles show without counts', async () => {
		const notFound = () => Response.json({ error: { type: 'not_found', message: 'no application whose people you administer' } }, { status: 404 })
		expect(await readRoleHolders('notes@prod', answering(notFound))).toBeNull()
		expect(await readRoleHolders('notes@prod', answering(() => new Response('down', { status: 503 })))).toBeNull()
	})
})
