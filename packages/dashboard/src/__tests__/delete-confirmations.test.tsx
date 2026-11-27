// A delete confirmation on an application's Settings says what goes and what stays, as Control's delete does it.

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeleteEnvironmentConsequences } from '../components/app-detail/EnvironmentsSection'
import { DeleteAppConsequences } from '../routes/apps/settings'

const text = (html: string): string => html.replace(/<[^>]+>/g, '')

describe('delete confirmations', () => {
	test('deleting an environment names what goes and what stays with the platform and at the hosting', () => {
		const routed = { env: 'test', domain: 'notes-test.example.test', namespaceId: 'apps-prod' }
		const words = text(renderToStaticMarkup(<DeleteEnvironmentConsequences appId="notes" env={routed} />))
		expect(words).toContain('Delete environment test of notes?')
		const [goes = '', stays = ''] = words.split('Stays:')
		expect(goes).toContain('notes-test.example.test no longer reaches it through the platform')
		expect(goes).toContain('a push no longer deploys test')
		expect(goes).toContain('keys and credentials')
		expect(goes).toContain('list of backups')
		expect(stays).toContain('what runs at the hosting, and its data: it keeps running, unreachable through the platform,')
		expect(stays).toContain('deploy history')
		expect(stays).toContain('an environment added again as test starts with them')
	})

	test('an environment no namespace proxy routes keeps being served wherever the hosting serves it', () => {
		const words = text(renderToStaticMarkup(<DeleteEnvironmentConsequences appId="notes" env={{ env: 'test', domain: null, namespaceId: null }} />))
		expect(words).not.toContain('route')
		expect(words).not.toContain('unreachable')
	})

	test('deleting an application says its deploy history goes with it', () => {
		const words = text(
			renderToStaticMarkup(
				<DeleteAppConsequences appId="notes" envs={[{ env: 'prod', namespaceId: 'apps-prod' }, { env: 'test', namespaceId: 'apps-prod' }]} />,
			),
		)
		const [goes = '', stays = ''] = words.split('Stays:')
		expect(goes).toContain('its domains no longer reach it through the platform')
		expect(goes).toContain('its environments (prod, test)')
		expect(goes).toContain('secrets and variables')
		expect(goes).toContain('deploy history')
		expect(stays).toContain('it keeps running, unreachable through the platform, until you remove it there')
		expect(stays).not.toContain('history')
	})
})
