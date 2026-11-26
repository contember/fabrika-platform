import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeviationsSection } from '../components/app-detail/DeviationsSection'
import type { AppEnvDto, DeviationSubjectDto } from '../lib/api'
import { ChangeList } from '../routes/approvals/detail'

const environment = (env: string, deviationSubjects: DeviationSubjectDto[], isProtected = false): AppEnvDto => ({
	appId: 'notes',
	env,
	domain: null,
	publicOrigin: null,
	triggerRef: null,
	authoring: false,
	protected: isProtected,
	publishedRunId: deviationSubjects.length === 0 ? null : `01a144a6-${env}`,
	deviationSubjects,
	surface: [],
	namespaceId: null,
	provider: 'zerops',
	target: { provider: 'zerops', version: 1, payload: {} },
	artifact: { provider: 'zerops', version: 1, payload: {} },
	createdAt: 0,
})

// The real route of a run, so the summary's link resolves to the path the console serves.
const section = (env: AppEnvDto): string =>
	renderToStaticMarkup(createElement(BuzolaProvider, {
		router: new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry: { 'runs/detail': '/runs/:id' },
		}),
	}, createElement(DeviationsSection, { env })))

const items = (markup: string): string[] => [...markup.matchAll(/<li>(.*?)<\/li>/g)].map((match) => match[1] ?? '')

describe('deviations in the console', () => {
	test('the approval page marks each line off the paved road "needs closer review", and only those', () => {
		const markup = renderToStaticMarkup(createElement(ChangeList, {
			title: 'Widens access',
			icon: 'alert',
			changes: [
				{ effect: 'widens', line: 'Role `editor` gains `notes.delete`' },
				{ effect: 'widens', line: 'Endpoint `api.notes.summary` declares raw SQL (`read`)', review: 'closer' },
			],
		}))
		expect(items(markup)).toEqual([
			'Role <code>editor</code> gains <code>notes.delete</code>',
			'Endpoint <code>api.notes.summary</code> declares raw SQL (<code>read</code>) <span class="badge badge-warn">needs closer review</span>',
		])
	})

	test('every line for closer review in the list of every line says why', () => {
		const markup = renderToStaticMarkup(createElement(ChangeList, {
			title: 'Widens access',
			icon: 'alert',
			changes: [{ effect: 'widens', line: 'Endpoint `api.notes.summary` declares raw SQL (`read`)', review: 'closer', reason: 'off-road' }],
		}))
		expect(markup).toContain(
			'<span class="badge badge-warn">needs closer review</span><span class="change-reason muted small">A step off the paved road: read the code behind it, not only this line.</span>',
		)
	})

	test("an environment's published deviations are counted and listed by subject, protected or not", () => {
		const markup = section(environment('prod', [
			{ subject: 'Endpoint `api.notes.summary`', steps: ['declares raw SQL (`read`)', 'declares table `notes` unscoped (`read`)'] },
			{ subject: 'Migration `20261012100000_audit.sql`', steps: ['declares trigger `notes.audit_retitle`'] },
		], true))
		expect(markup).toContain('<h2>Off the paved road</h2>')
		expect(markup).toContain('3 steps beyond what prod&#x27;s endpoints declare as capabilities')
		expect(markup).toContain(
			'<li>Endpoint `api.notes.summary`<ul class="change-list"><li>declares raw SQL (`read`)</li><li>declares table `notes` unscoped (`read`)</li></ul></li>',
		)
		expect(markup).toContain(
			'<li>Migration `20261012100000_audit.sql`<ul class="change-list"><li>declares trigger `notes.audit_retitle`</li></ul></li>',
		)
		expect(section(environment('stage', [{ subject: 'Job `digest`', steps: ["sends e-mail through the installation's mail transport"] }]))).toContain(
			'1 step beyond',
		)
	})

	test('an inventory of what is published carries no "needs closer review" mark', () => {
		const markup = section(environment('prod', [{ subject: 'Endpoint `api.notes.summary`', steps: ['declares raw SQL (`read`)'] }], true))
		expect(markup).not.toContain('needs closer review')
		expect(markup).not.toContain('badge')
	})

	test('an application whose published access stays on the road shows no section', () => {
		expect(section(environment('prod', []))).toBe('')
	})
})
