// A delete confirmation on an application's Settings says what goes and what stays, as Control's delete does it.

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeleteEnvironmentConsequences } from '../components/app-detail/EnvironmentsSection'
import { DeleteAppConsequences } from '../routes/apps/settings'

const text = (html: string): string => html.replace(/<[^>]+>/g, '')

describe('delete confirmations', () => {
	test('deleting an environment names what goes and what stays with the platform and at the hosting', () => {
		const words = text(renderToStaticMarkup(<DeleteEnvironmentConsequences appId="notes" env="test" />))
		expect(words).toContain('Delete environment test of notes?')
		const [goes = '', stays = ''] = words.split('Stays:')
		expect(goes).toContain('a push no longer deploys test')
		expect(goes).toContain('list of backups')
		expect(stays).toContain('what runs at the hosting, and its data')
		expect(stays).toContain('deploy history')
		expect(stays).toContain('an environment added again as test starts with them')
	})

	test('deleting an application says its deploy history goes with it', () => {
		const words = text(renderToStaticMarkup(<DeleteAppConsequences appId="notes" envs={['prod', 'test']} />))
		const [goes = '', stays = ''] = words.split('Stays:')
		expect(goes).toContain('its environments (prod, test)')
		expect(goes).toContain('secrets and variables')
		expect(goes).toContain('deploy history')
		expect(stays).toContain('what runs at the hosting, and its data')
		expect(stays).not.toContain('history')
	})
})
