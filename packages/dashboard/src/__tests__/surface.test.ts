import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SurfaceSection, surfaceSummary } from '../components/app-detail/SurfaceSection'
import type { AppEnvDto, SurfaceEndpointDto } from '../lib/api'

const FORM: SurfaceEndpointDto = {
	id: 'apply',
	method: 'POST',
	path: '/apply',
	kind: 'form',
	reach: 'anyone',
	callers: [],
	requirement: null,
	notes: ['no rate limit and no challenge'],
}
const GET: SurfaceEndpointDto = {
	id: 'api.get',
	method: 'POST',
	path: '/api/get',
	kind: 'query',
	reach: 'machine',
	callers: ['human', 'machine'],
	requirement: 'with `notes.read` (on `note`)',
	notes: [],
}
const SPA: SurfaceEndpointDto = {
	...GET,
	id: 'app',
	method: 'GET',
	path: '/*',
	kind: 'spa',
	reach: 'human',
	callers: ['human'],
	requirement: 'who are members',
}

const environment = (env: string, surface: SurfaceEndpointDto[]): AppEnvDto => ({
	appId: 'notes',
	env,
	domain: `${env}.notes.example.test`,
	publicOrigin: null,
	crossOrigins: [],
	triggerRef: null,
	authoring: false,
	protected: false,
	publishedRunId: surface.length === 0 ? null : `01a144a6-${env}`,
	deviationSubjects: [],
	surface,
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
	}, createElement(SurfaceSection, { envs })))

describe('the surface in the console', () => {
	test('the summary counts the endpoints of each reach, most exposed first, and names only the reaches there are', () => {
		expect(surfaceSummary([FORM, GET, SPA, { ...SPA, id: 'app.prefix', path: '/' }])).toBe('1 for anyone · 1 for machines · 2 for signed-in people')
	})

	test('each published environment opens on a row per endpoint; one with nothing published is left out', () => {
		const markup = section([environment('prod', [FORM, GET]), environment('dev', [])])
		const summaries = [...markup.matchAll(/<summary>(.*?)<\/summary>/g)].map((match) => match[1] ?? '')
		expect(summaries).toEqual([
			'<span class="chip">prod</span><code>prod.notes.example.test</code>'
			+ '<span>1 for anyone · 1 for machines, published by <a href="/runs/01a144a6-prod">run <code>01a144a6</code></a></span>',
		])
		expect(markup).toContain('<span class="chip chip-accent">anyone</span>')
		expect(markup).toContain('<td><span class="muted">nothing</span></td><td>no rate limit and no challenge</td>')
		expect(markup).toContain('<td><span class="muted small">human, machine</span> with `notes.read` (on `note`)</td>')
	})

	test('an application with nothing published shows no section', () => {
		expect(section([environment('prod', [])])).toBe('')
	})
})
