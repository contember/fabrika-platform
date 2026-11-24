import { describe, expect, test } from 'bun:test'
import { COMPOSE_PROJECT, composeProjectName } from '../compose'
import { REPO_ROOT } from '../prepare'

// Compose names a project's volumes `<project>_<volume>`: two checkouts that shared a project shared their databases.
describe('the local compose project', () => {
	test('each checkout gets its own project, so its own volumes', () => {
		const first = composeProjectName('/work/fabrika-platform-wt/fix-a')
		const second = composeProjectName('/work/fabrika-platform-wt/fix-b')
		const sameName = composeProjectName('/elsewhere/fix-a')
		expect(new Set([first, second, sameName]).size).toBe(3)
		expect(first).toStartWith('fabrika-local-fix-a-')
		expect(sameName).toStartWith('fabrika-local-fix-a-')
	})

	test('a checkout keeps its project between runs, so down and reset reach the volumes up created', () => {
		expect(composeProjectName('/work/fabrika-platform')).toBe(composeProjectName('/work/fabrika-platform'))
		expect(COMPOSE_PROJECT).toBe(composeProjectName(REPO_ROOT))
	})

	test('the name is one Compose accepts, whatever the directory is called', () => {
		for (const root of ['/work/Fabrika Platform.WT', '/work/čeština', '/', `/work/${'x'.repeat(200)}`]) {
			expect(composeProjectName(root)).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
		}
	})
})
