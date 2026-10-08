import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { type AppRow, ControlRegistryRepository, createControlRepositories } from '../db'

class SpecializedRegistryRepository extends ControlRegistryRepository {
	override listApps(): Promise<AppRow[]> {
		return Promise.resolve([])
	}
}

describe('control repository composition', () => {
	test('replaces one complete capability without changing the portable remainder', async () => {
		const registry = new SpecializedRegistryRepository(unusedDatabase)
		const repositories = createControlRepositories(unusedDatabase, { replacements: { registry } })

		expect(repositories.registry).toBe(registry)
		expect(await repositories.registry.listApps()).toEqual([])
		expect(repositories.runs).toBeDefined()
		expect(repositories.polling).toBeDefined()
		expect(repositories.operationsCatalog).toBeDefined()
		expect(repositories.githubConnections).toBeDefined()
	})
})
