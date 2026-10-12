import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeviationsSection } from '../components/app-detail/DeviationsSection'
import type { AppEnvDto } from '../lib/api'
import { ChangeList } from '../routes/approvals/detail'

const environment = (env: string, deviations: string[], isProtected = false): AppEnvDto => ({
	appId: 'notes',
	env,
	domain: null,
	publicOrigin: null,
	triggerRef: null,
	authoring: false,
	protected: isProtected,
	publishedRunId: deviations.length === 0 ? null : 'run-1',
	deviations,
	namespaceId: null,
	provider: 'zerops',
	target: { provider: 'zerops', version: 1, payload: {} },
	artifact: { provider: 'zerops', version: 1, payload: {} },
	createdAt: 0,
})

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

	test("the environment page lists every environment's published deviations, protected or not, each needing closer review", () => {
		const markup = renderToStaticMarkup(createElement(DeviationsSection, {
			envs: [
				environment('prod', ['Migration `20261012100000_audit.sql` declares trigger `notes.audit_retitle`'], true),
				environment('stage', ['Endpoint `api.notes.summary` declares raw SQL (`read`)']),
				environment('dev', []),
			],
		}))
		expect(markup).toContain('<span class="chip">prod</span><span class="muted small">protected</span>')
		expect(markup).toContain('<span class="chip">stage</span>')
		expect(markup).not.toContain('dev')
		expect(items(markup)).toEqual([
			'Migration `20261012100000_audit.sql` declares trigger `notes.audit_retitle` <span class="badge badge-warn">needs closer review</span>',
			'Endpoint `api.notes.summary` declares raw SQL (`read`) <span class="badge badge-warn">needs closer review</span>',
		])
	})

	test('an application whose published access stays on the road shows no section', () => {
		expect(renderToStaticMarkup(createElement(DeviationsSection, { envs: [environment('prod', [])] }))).toBe('')
	})
})
