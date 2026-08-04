import type { SqlDatabase } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { createIamRepositories, PrincipalRepository, type PrincipalRow } from '../db'

const unusedDatabase: SqlDatabase = {
	prepare() {
		throw new Error('query must not run')
	},
	batch() {
		return Promise.reject(new Error('batch must not run'))
	},
}

class SpecializedPrincipalRepository extends PrincipalRepository {
	override listPrincipals(): Promise<PrincipalRow[]> {
		return Promise.resolve([])
	}
}

describe('IAM repository composition', () => {
	test('replaces one complete capability without changing the portable remainder', async () => {
		const principals = new SpecializedPrincipalRepository(unusedDatabase)
		const repositories = createIamRepositories(unusedDatabase, { principals })

		expect(repositories.principals).toBe(principals)
		expect(await repositories.principals.listPrincipals({ limit: 50 })).toEqual([])
		expect(repositories.grants).toBeDefined()
		expect(repositories.appSchema).toBeDefined()
	})
})
