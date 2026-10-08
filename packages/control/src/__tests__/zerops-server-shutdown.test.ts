import { SqlDeployLocks } from '@fabrika/platform'
import { createBackgroundTasks } from '@fabrika/platform-node'
import { describe, expect, jest, test } from 'bun:test'
import { CATALOG_LEASE_KEY, LEASE_TTL_MS } from '../lease'
import { projectOperationsCatalogChange, reopenCatalogProjection } from '../operations-catalog'
import { stopControlServer } from '../zerops/server'
import { createHarness } from './helpers/harness'
import { providerEnvironment } from './helpers/provider'

const SYNC_KEY = 'catalog-sync-key-with-at-least-32-characters'

/** True when nobody holds the catalog lease; the probe that takes it gives it straight back. */
async function leaseIsFree(locks: SqlDeployLocks): Promise<boolean> {
	if (!(await locks.acquire(CATALOG_LEASE_KEY, 'probe', LEASE_TTL_MS))) return false
	await locks.release(CATALOG_LEASE_KEY, 'probe')
	return true
}

/** A lease store whose release never answers, like a database call that hangs. */
class StalledReleaseLocks extends SqlDeployLocks {
	releasing = false

	override release(): Promise<void> {
		this.releasing = true
		return new Promise<void>(() => {})
	}
}

describe('Zerops control server shutdown (backlog 84)', () => {
	test("the SIGTERM sequence releases a running catalog flush's lease after the grace, before the consumer has stopped", async () => {
		const harness = createHarness()
		await harness.repositories.registry.createApp({ id: 'app-a', repoUrl: 'github.com/acme/app-a' })
		await harness.repositories.registry.upsertAppEnv(providerEnvironment('app-a', 'prod'))
		const locks = new SqlDeployLocks(harness.d1)
		const tasks = createBackgroundTasks({ label: 'shutdown test task' })
		let requests = 0
		// Operations never answers; only the lease's abort ends the request.
		const service = {
			fetch: (request: Request): Promise<Response> => {
				requests++
				return new Promise<Response>((_, reject) => {
					request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
				})
			},
		}
		const deps = { catalog: harness.repositories.operationsCatalog, locks, service, syncKey: SYNC_KEY, operationsOrigin: 'https://errors.example.test' }
		const flush = projectOperationsCatalogChange(deps)
		tasks.waitUntil(flush)
		while (requests === 0) await Bun.sleep(1)
		expect(await leaseIsFree(locks)).toBe(false)

		const order: string[] = []
		try {
			await stopControlServer({
				server: { stop: async () => void order.push('server') },
				requests: { drain: async () => void order.push('requests') },
				// A long deploy job keeps the consumer busy; the catalog lease must not wait for it.
				consumer: {
					stop: async () => {
						for (let spins = 0; !(await leaseIsFree(locks)); spins++) {
							if (spins > 1_000) throw new Error('the catalog lease was never released')
							await Bun.sleep(5)
						}
						order.push('consumer')
					},
				},
				runtime: {
					env: { WAIT_UNTIL: tasks.waitUntil },
					shutdown: async () => {
						await tasks.drain()
						order.push('pool')
					},
				},
			}, 10)

			expect(order).toEqual(['server', 'requests', 'consumer', 'pool'])
			expect(await flush).toEqual({ outcome: 'failed', revision: 1 })
			expect(await leaseIsFree(locks)).toBe(true)
			// The closing process takes no new lease, so a late change is left to the next process.
			expect(await projectOperationsCatalogChange(deps)).toEqual({ outcome: 'coalesced', revision: 2 })
			expect(requests).toBe(1)
		} finally {
			reopenCatalogProjection()
		}
	})

	test('a lease release that stalls before SIGTERM cannot hold up the drain past its bound', async () => {
		const harness = createHarness()
		await harness.repositories.registry.createApp({ id: 'app-a', repoUrl: 'github.com/acme/app-a' })
		await harness.repositories.registry.upsertAppEnv(providerEnvironment('app-a', 'prod'))
		const [source] = (await harness.repositories.operationsCatalog.snapshot()).sources
		if (source === undefined) throw new Error('expected one catalog source')
		const locks = new StalledReleaseLocks(harness.d1)
		const tasks = createBackgroundTasks({ label: 'shutdown test task' })
		const service = {
			fetch: async (): Promise<Response> =>
				Response.json({
					revision: 1,
					outcome: 'applied',
					ingest: [{
						coordinate: { appId: 'app-a', environment: 'prod', serviceKey: 'default' },
						credentialId: source.credential_id,
						ingestProjectId: '100000000000000001',
					}],
				}),
		}
		const originalWarn = console.warn
		const warnings: string[] = []
		console.warn = (...values) => warnings.push(values.map(String).join(' '))
		jest.useFakeTimers()
		try {
			tasks.waitUntil(projectOperationsCatalogChange({
				catalog: harness.repositories.operationsCatalog,
				locks,
				service,
				syncKey: SYNC_KEY,
				operationsOrigin: 'https://errors.example.test',
			}))
			for (let spins = 0; !locks.releasing; spins++) {
				if (spins > 10_000) throw new Error('flush never reached its release')
				await new Promise((resolve) => setImmediate(resolve))
			}
			let stopped = false
			const stopping = stopControlServer({
				server: { stop: async () => {} },
				requests: { drain: async () => {} },
				consumer: { stop: async () => {} },
				runtime: { env: { WAIT_UNTIL: tasks.waitUntil }, shutdown: () => tasks.drain() },
			}, 10).then(() => {
				stopped = true
			})
			for (let spins = 0; spins < 100; spins++) await new Promise((resolve) => setImmediate(resolve))
			expect(stopped).toBe(false)
			jest.advanceTimersByTime(5_000)
			for (let spins = 0; !stopped && spins < 10_000; spins++) await new Promise((resolve) => setImmediate(resolve))
			expect(stopped).toBe(true)
			await stopping
			expect(tasks.pending).toBe(0)
		} finally {
			jest.useRealTimers()
			console.warn = originalWarn
			reopenCatalogProjection()
		}
		expect(warnings).toEqual(['operations catalog lock release timed out'])
	})
})
