// The one thing the live consumer must refuse to do, proved against the double.
//
// The table is DATA, and data is easy to change without noticing what it now authorises: a row carries a
// request shape whether or not it is probed, so flipping `project-delete-is-a-process` to a live class
// would hand a real account a `DELETE /project/{id}`. The guard refuses before anything reaches the
// transport, which is what the recording fetch below checks.

import { describe, expect, test } from 'bun:test'
import { assertLiveRowIsSafe, factsFor, type FactTransport, PLATFORM_FACTS, runFact } from '../../../provider-zerops/src/__tests__/platform-facts'
import { createZeropsEmulator } from '../zerops-emulator'

const token = 'local-test-token'
const baseUrl = 'http://zerops.local/api/rest/public'

/** The double, plus a record of every request that reached it. */
const recordingTransport = async (): Promise<{ transport: FactTransport; calls: string[] }> => {
	const handler = await createZeropsEmulator({ token })
	const calls: string[] = []
	return {
		calls,
		transport: {
			baseUrl,
			token,
			fetch: (url, init) => {
				calls.push(`${init?.method ?? 'GET'} ${url}`)
				return handler(new Request(url, init))
			},
			sleep: async () => {},
			signal: AbortSignal.timeout(10_000),
		},
	}
}

const projectDeleteRow = () => {
	const row = PLATFORM_FACTS.find((fact) => fact.id === 'project-delete-is-a-process')
	if (row === undefined) throw new Error('the project delete row is missing from the table')
	return row
}

describe('the live consumer refuses to delete a project', () => {
	test('refuses the row that carries a project DELETE, whatever its live class says', () => {
		expect(() => assertLiveRowIsSafe(projectDeleteRow())).toThrow('must never DELETE /project/{projectId}')
	})

	test('refuses before a single request reaches the transport', async () => {
		const { transport, calls } = await recordingTransport()
		// The row as a live consumer would take it — probed, not recorded.
		const probed = { ...projectDeleteRow(), live: 'fast' as const }

		let refused = false
		try {
			assertLiveRowIsSafe(probed)
			await runFact({ transport, fact: probed, context: new Map([['projectId', 'project-000001']]) })
		} catch {
			refused = true
		}

		expect(refused).toBe(true)
		expect(calls).toEqual([])
	})

	test('lets every row the live suite actually runs through, build rows included', () => {
		for (const fact of factsFor('live', { slow: true })) {
			expect(() => assertLiveRowIsSafe(fact)).not.toThrow()
		}
	})
})
