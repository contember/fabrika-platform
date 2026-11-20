// The body of every file of the run: it checks that it starts clean, then leaves state behind for the next file to
// not see. The guard test runs these files in one process, in random orders.

import { createClient } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, expect, test } from 'bun:test'
import { contract, implementation } from './app'
import { settings } from './settings'

/** How far the clock may be from the monotonic one before a fake clock (`setSystemTime`) counts as leaked. */
const CLOCK_SLACK_MS = 60_000

export async function cleanFile(name: string): Promise<void> {
	const sqlite = await testDatabase({ migrations: new URL('../cloudflare-fixture/db/migrations/', import.meta.url), label: name })
	const kit = testKit(implementation, { database: sqlite.database })
	afterAll(async () => {
		await kit.drain()
		await sqlite.close()
	})
	const api = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w1' } }])) })

	// One test: `--randomize` shuffles the tests of a file too, and the check must come before the state it leaves.
	test(`${name} starts clean and leaves state behind`, async () => {
		expect(Math.abs(Date.now() - (performance.timeOrigin + performance.now())), 'a file left the clock set').toBeLessThan(CLOCK_SLACK_MS)
		expect(settings.mode, 'a file changed or mocked a module').toBe('clean')
		expect(await api.notes.titles({ workspaceId: 'w1' }), "another file's rows").toEqual({ titles: [] })
		expect(await api.notes.calls({ workspaceId: 'w1' }), "another file's deps").toEqual({ calls: 1 })

		await api.notes.create({ workspaceId: 'w1', title: name })
		await api.notes.calls({ workspaceId: 'w1' })
		expect(await api.notes.titles({ workspaceId: 'w1' })).toEqual({ titles: [name] })
	})
}
