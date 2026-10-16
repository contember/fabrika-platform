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
	namespaceId: null,
	provider: 'zerops',
	target: { provider: 'zerops', version: 1, payload: {} },
	artifact: { provider: 'zerops', version: 1, payload: {} },
	createdAt: 0,
})

// The real route of a run, so the summary's link resolves to the path the console serves.
const section = (envs: readonly AppEnvDto[]): string =>
	renderToStaticMarkup(createElement(BuzolaProvider, {
		router: new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry: { 'runs/detail': '/runs/:id' },
		}),
	}, createElement(DeviationsSection, { envs })))

const items = (markup: string): string[] => [...markup.matchAll(/<li>(.*?)<\/li>/g)].map((match) => match[1] ?? '')

describe('deviations in the console', () => {
	test('the approval page marks each line off the paved road "needs closer review", and only those', () => {
		const markup = renderToStaticMarkup(createElement(ChangeList, {
			title: 'Widens access',
			icon: 'alert',
			changes: [
				{ widens: true, line: 'Role `editor` gains `notes.delete`' },
				{ widens: true, line: 'Endpoint `api.notes.summary` declares raw SQL (`read`)', review: 'closer' },
			],
		}))
		expect(items(markup)).toEqual([
			'Role `editor` gains `notes.delete`',
			'Endpoint `api.notes.summary` declares raw SQL (`read`) <span class="badge badge-warn">needs closer review</span>',
		])
	})

	test("the environment page summarizes each environment's published deviations, protected or not, and lists them on demand", () => {
		const markup = section([
			environment('prod', [
				{ subject: 'Endpoint `api.notes.summary`', steps: ['declares raw SQL (`read`)', 'declares table `notes` unscoped (`read`)'] },
				{ subject: 'Migration `20261012100000_audit.sql`', steps: ['declares trigger `notes.audit_retitle`'] },
			], true),
			environment('stage', [{ subject: 'Job `digest`', steps: ["sends e-mail through the installation's mail transport"] }]),
			environment('dev', []),
		])
		const summaries = [...markup.matchAll(/<summary>(.*?)<\/summary>/g)].map((match) => match[1] ?? '')
		expect(summaries).toEqual([
			'<span class="chip">prod</span><span class="muted small">protected</span>'
			+ '<span>3 steps off the paved road, published by <a href="/runs/01a144a6-prod">run <code>01a144a6</code></a></span>',
			'<span class="chip">stage</span><span>1 step off the paved road, published by <a href="/runs/01a144a6-stage">run <code>01a144a6</code></a></span>',
		])
		expect(markup).not.toContain('<span class="chip">dev</span>')
		expect(markup).toContain('<details class="deviations">')
		expect(markup).not.toContain('<details class="deviations" open')
		expect(markup).toContain(
			'<li>Endpoint `api.notes.summary`<ul class="change-list"><li>declares raw SQL (`read`)</li><li>declares table `notes` unscoped (`read`)</li></ul></li>',
		)
		expect(markup).toContain(
			'<li>Migration `20261012100000_audit.sql`<ul class="change-list"><li>declares trigger `notes.audit_retitle`</li></ul></li>',
		)
	})

	test('an inventory of what is published carries no "needs closer review" mark', () => {
		const markup = section([environment('prod', [{ subject: 'Endpoint `api.notes.summary`', steps: ['declares raw SQL (`read`)'] }], true)])
		expect(markup).not.toContain('needs closer review')
		expect(markup).not.toContain('badge')
	})

	test('an application whose published access stays on the road shows no section', () => {
		expect(section([environment('prod', [])])).toBe('')
	})
})
