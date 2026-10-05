import { Container, D1Database, R2Bucket, type Worker } from '@fabrika/provider-cloudflare'
import { describe, expect, test } from 'bun:test'
import config, { buildRunnerWorker } from '../../fabrika-runner.config'

// vozka-runner's own deploy surface uses the Cloudflare provider authoring API.
// These tests prove: defineApp accepts it, the resource graph materializes the executor's binding set
// (the RunnerContainer DO + the SHARED, adopted-by-name R2/D1), and it is INFRA — no Access, no schema,
// no runtime secrets. The shared D1 must NOT declare a migrations dir (the control plane owns the schema).

/** Resolve a Worker binding by name (oblaka exposes the materialized graph on `worker.options`). */
function binding(worker: Worker, name: string): unknown {
	return worker.options.bindings?.[name]
}

describe('defineApp(vozka-runner config)', () => {
	test('exports a valid AppConfig with id `vozka-runner` and the worker entry', () => {
		expect(config.id).toBe('vozka-runner')
		const worker = config.resources({ env: 'stage' })
		expect(worker.options.name).toBe('vozka-runner')
		expect(worker.options.main).toBe('./src/worker.ts')
	})

	test('binds the RunnerContainer DO + the shared (adopted) R2 + D1', () => {
		const worker = buildRunnerWorker({ env: 'stage' })
		const container = binding(worker, 'RUNNER')
		expect(container).toBeInstanceOf(Container)
		if (!(container instanceof Container)) throw new Error('RUNNER must be a Container')
		expect(container.options.className).toBe('RunnerContainer')
		expect(binding(worker, 'RUN_LOGS')).toBeInstanceOf(R2Bucket)
		expect(binding(worker, 'DB')).toBeInstanceOf(D1Database)
	})

	test('the shared resources keep the control plane names (so oblaka ADOPTS them, not create new)', () => {
		const worker = buildRunnerWorker({ env: 'stage' })
		const logs = binding(worker, 'RUN_LOGS')
		const db = binding(worker, 'DB')
		if (!(logs instanceof R2Bucket)) throw new Error('RUN_LOGS must be an R2Bucket')
		if (!(db instanceof D1Database)) throw new Error('DB must be a D1Database')
		expect(logs.options.name).toBe('vozka-run-logs')
		expect(db.options.name).toBe('vozka')
		// The control plane owns the shared schema and its migrations.
		expect(db.options.migrationsDir).toBeUndefined()
	})

	test.each(['local', 'stage', 'prod'])('%s builds the account-owned image from this checkout', (env) => {
		const container = binding(buildRunnerWorker({ env }), 'RUNNER')
		if (!(container instanceof Container)) throw new Error(`${env}: RUNNER must be a Container`)
		expect(container.options.image).toBe('../runner-container/Dockerfile')
		expect(container.options.imageBuildContext).toBe('../..')
		expect(container.options.rolloutActiveGracePeriod).toBe(1_200)
	})

	test('it is INFRA: no schema, and the only runtime secret is the caller key', () => {
		expect(config.schema).toBeUndefined()
		// The Worker DOES hold one credential now — the shared key it verifies on every RPC. Anything
		// else in this list would be a per-run credential that belongs in the job, not on the Worker.
		expect(config.pipeline?.secrets).toEqual(['FABRIKA_RUNNER_KEY'])
		expect(config.pipeline?.workerDir).toBe('.')
	})

	test('it publishes no hostname of its own — no workers.dev, no preview URLs', () => {
		for (const env of ['local', 'stage', 'prod']) {
			const worker = buildRunnerWorker({ env })
			expect(worker.options.routes).toEqual([])
			expect(worker.options.workers_dev).toBe(false)
			expect(worker.options.preview_urls).toBe(false)
		}
	})
})
