import type { ConsoleAccessDto } from '@fabrika/control-contract'
import type { AppDto, IamAdministrationScope } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { grantTargets } from '../access/lib/administration'
import { type ConsoleCaller, holdsAt, mayDo, mayOpen, type NavPage, scopedRunReads } from '../lib/console-access'
import { signOutUrl } from '../lib/session'
import { NoAccess, visibleNav } from '../routes/_layout'

const DEPLOY = ['deploy.trigger', 'deploy.read']
const OPERATIONS = ['operations.read', 'operations.triage', 'operations.manage']
const EVERYTHING = [
	...DEPLOY,
	'app.manage',
	'namespace.manage',
	'secret.manage',
	'source.connection.manage',
	'source.workspace.read',
	'source.workspace.write',
	'source.pull-request.create',
	'access.approve',
	...OPERATIONS,
]

function caller(
	access: Partial<ConsoleAccessDto>,
	iam: { iam?: IamAdministrationScope | false | null; administersPeople?: boolean | null } = {},
): ConsoleCaller {
	return {
		access: { principal: { id: 'user-1', label: 'ada@example.com' }, global: [], scopes: [], ...access },
		iam: iam.iam ?? false,
		administersPeople: iam.administersPeople ?? false,
	}
}

/** The rail as labels, section by section, the way a person reads it. */
function rail(of: ConsoleCaller): string[] {
	const { lead, sections } = visibleNav(of)
	return [
		...(lead === null ? [] : ['Overview']),
		...sections.map((section) => `${section.label}: ${section.items.map((item) => item.label).join(', ')}`),
	]
}

describe('the console shows what its caller may use', () => {
	test('a caller with no grant anywhere has no page', () => {
		expect(rail(caller({}))).toEqual([])
	})

	test('an admin of the console and of IAM sees every section', () => {
		expect(rail(caller({ global: EVERYTHING }, { iam: { kind: 'installation' } }))).toEqual([
			'Overview',
			'Delivery: Applications, Namespaces, Deploy runs, Approvals, Source connection',
			'Access: Overview, Users, Credentials, Permissions, Audit',
			'Operations: Overview, Errors, Sources, Releases, Health',
		])
	})

	test('an observer and a triager see only Operations', () => {
		expect(rail(caller({ global: ['operations.read'] }))).toEqual(['Operations: Overview, Errors, Sources, Releases, Health'])
		expect(rail(caller({ global: ['operations.read', 'operations.triage'] }))).toEqual(['Operations: Overview, Errors, Sources, Releases, Health'])
	})

	test('operations.read scoped to one app still opens Operations', () => {
		const scoped = caller({ scopes: [{ type: 'app', value: 'notes', actions: ['operations.read'] }] })
		expect(mayOpen(scoped, 'operations/errors')).toBe(true)
		expect(rail(scoped)).toEqual(['Operations: Overview, Errors, Sources, Releases, Health'])
	})

	test('a deployer sees the deploy runs and no registry page', () => {
		expect(rail(caller({ global: DEPLOY }))).toEqual(['Delivery: Deploy runs'])
	})

	test('an operator sees deploy runs and Operations, and no overview, which needs the registry', () => {
		expect(rail(caller({ global: [...DEPLOY, ...OPERATIONS] }))).toEqual([
			'Delivery: Deploy runs',
			'Operations: Overview, Errors, Sources, Releases, Health',
		])
	})

	test('an IAM administrator with no console role sees Access, and an application administrator sees People', () => {
		expect(rail(caller({}, { iam: { kind: 'installation' } }))).toEqual(['Access: Overview, Users, Credentials, Permissions, Audit'])
		expect(rail(caller({}, { administersPeople: true }))).toEqual(['Your applications: People'])
	})

	test('a user administrator sees the Users of Access and no other Access page (ADR-0058)', () => {
		for (const scope of [{ kind: 'users', apps: null }, { kind: 'users', apps: ['crm@prod'] }] as const) {
			expect(rail(caller({}, { iam: scope }))).toEqual(['Access: Users'])
			expect(mayOpen(caller({}, { iam: scope }), 'access/credentials')).toBe(false)
		}
	})

	test('a part nobody answered for is shown, so its own page reports the outage', () => {
		const unknown: ConsoleCaller = { access: null, iam: null, administersPeople: null }
		const pages: NavPage[] = ['index', 'apps', 'runs', 'access/users', 'operations', 'people']
		expect(pages.every((page) => mayOpen(unknown, page))).toBe(true)
	})
})

describe('the grant form offers what the caller may grant (ADR-0058)', () => {
	const apps: AppDto[] = [
		{ id: 'vozka', displayName: 'Console', installation: true },
		{ id: 'propustka', displayName: 'Access', installation: true },
		{ id: 'crm@prod', displayName: 'CRM', installation: false },
		{ id: 'notes@prod', displayName: null, installation: false },
	]
	const ids = (targets: { apps: AppDto[] }) => targets.apps.map((app) => app.id)

	test('an installation administrator gets every app and the cross-app option', () => {
		const targets = grantTargets(apps, { kind: 'installation' })
		expect([ids(targets), targets.crossApp]).toEqual([['vozka', 'propustka', 'crm@prod', 'notes@prod'], true])
	})

	test("a user administrator gets the applications in its scope, never the installation's own, never cross-app", () => {
		const everywhere = grantTargets(apps, { kind: 'users', apps: null })
		expect([ids(everywhere), everywhere.crossApp]).toEqual([['crm@prod', 'notes@prod'], false])
		expect(ids(grantTargets(apps, { kind: 'users', apps: ['crm@prod', 'vozka'] }))).toEqual(['crm@prod'])
	})
})

describe('an action at an application environment', () => {
	const access: ConsoleAccessDto = {
		principal: null,
		global: ['deploy.read'],
		scopes: [
			{ type: 'app', value: 'notes', actions: ['deploy.trigger'] },
			{ type: 'environment', value: 'stage', actions: ['deploy.trigger', 'operations.triage'] },
		],
	}

	test('is held globally, at the app, or at the environment', () => {
		expect(holdsAt(access, 'deploy.read', { app: 'blog', env: 'prod' })).toBe(true)
		expect(holdsAt(access, 'deploy.trigger', { app: 'notes', env: 'prod' })).toBe(true)
		expect(holdsAt(access, 'deploy.trigger', { app: 'blog', env: 'stage' })).toBe(true)
		expect(holdsAt(access, 'deploy.trigger', { app: 'blog', env: 'prod' })).toBe(false)
	})

	test('is offered when access is unknown', () => {
		expect(mayDo(null, 'deploy.trigger', { app: 'blog', env: 'prod' })).toBe(true)
		expect(mayDo(access, 'operations.triage')).toBe(true)
		expect(mayDo(access, 'operations.manage')).toBe(false)
	})

	test('a scoped run reader starts filtered to what it reads', () => {
		const scoped: ConsoleAccessDto = {
			principal: null,
			global: [],
			scopes: [{ type: 'app', value: 'notes', actions: ['deploy.read'] }, { type: 'environment', value: 'stage', actions: ['deploy.read'] }],
		}
		expect(scopedRunReads(scoped)).toEqual({ apps: ['notes'], environments: ['stage'] })
	})
})

test('the no-access page names who is signed in and offers signing in as someone else', () => {
	const markup = renderToStaticMarkup(createElement(NoAccess, {
		session: { ...caller({}), principal: { id: 'user-1', label: 'ada@example.com' }, signOutUrl: signOutUrl('https://iam.example.com') },
	}))
	expect(markup).toContain('You have no access to this console yet')
	expect(markup).toContain('<strong title="user-1">ada@example.com</strong>')
	expect(markup).toContain('Ask an administrator to grant you a role.')
	expect(markup).toContain('href="https://iam.example.com/auth/logout?redirect=')
})
