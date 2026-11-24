import { D1Database, NO_IMPORTABLE_ENV_FLAG, NO_PROCESS_ENV_FLAG, Queue, R2Bucket, ServiceReference, Worker } from '@fabrika/provider-cloudflare'
import { describe, expect, test } from 'bun:test'
import config, { buildOperationsWorker } from '../../fabrika.config'

const binding = (worker: Worker, name: string): unknown => worker.options.bindings?.[name]

/** Run `body` with the name scheme set, then put back what was there before, set or not. */
const withNames = (scheme: string, body: () => void): void => {
	const before = process.env['FABRIKA_CLOUDFLARE_NAMES']
	process.env['FABRIKA_CLOUDFLARE_NAMES'] = scheme
	try {
		body()
	} finally {
		if (before === undefined) delete process.env['FABRIKA_CLOUDFLARE_NAMES']
		else process.env['FABRIKA_CLOUDFLARE_NAMES'] = before
	}
}

const nameOf = (value: unknown): unknown => {
	if (!(value instanceof D1Database || value instanceof R2Bucket || value instanceof Queue)) throw new Error('expected a resource')
	return value.options.name
}

const remoteService = (value: unknown, env: string): unknown => {
	if (!(value instanceof ServiceReference)) throw new Error('expected a ServiceReference')
	return value.configureBinding({ config: {}, binding: 'X', env }).services?.[0]?.service
}

const application = (worker: Worker): Worker => {
	const value = binding(worker, 'APP')
	if (!(value instanceof Worker)) throw new Error('expected proxy APP Worker binding')
	return value
}

describe('Operations Cloudflare composition', () => {
	test('owns persistence, payload storage, ingest queue, DLQ, cron, and IAM binding', () => {
		const proxy = config.resources({ env: 'prod', domain: 'errors.example.test' })
		expect(proxy.options.name).toBe('operations-proxy')
		expect(proxy.options.main).toBe('./proxy-worker.ts')
		expect(proxy.options.routes).toEqual([{ pattern: 'errors.example.test', custom_domain: true }])
		expect(binding(proxy, 'IAM')).toBeInstanceOf(ServiceReference)
		const worker = application(proxy)
		expect(worker.options.name).toBe('operations')
		expect(worker.options.main).toBe('./src/worker.ts')
		expect(worker.options.routes).toEqual([])
		expect(worker.options.workers_dev).toBe(false)
		expect(binding(worker, 'DB')).toBeInstanceOf(D1Database)
		expect(binding(worker, 'PAYLOADS')).toBeInstanceOf(R2Bucket)
		expect(binding(worker, 'INGEST_QUEUE')).toBeInstanceOf(Queue)
		expect(binding(worker, 'INGEST_DLQ')).toBeInstanceOf(Queue)
		expect(binding(worker, 'IAM')).toBeInstanceOf(ServiceReference)
		expect(binding(worker, 'CONTROL')).toBeUndefined()
		expect(binding(worker, 'PIPELINE_METRICS')).toBeUndefined()
		expect(worker.options.vars?.['FABRIKA_IAM_ISSUER']).toBeDefined()
		expect(worker.options.triggers?.crons).toEqual(['* * * * *'])
	})

	test('the main queue exhausts into the environment-qualified DLQ', () => {
		const worker = application(config.resources({ env: 'stage' }))
		const queue = binding(worker, 'INGEST_QUEUE')
		expect(queue).toBeInstanceOf(Queue)
		if (queue instanceof Queue) {
			expect(queue.options.consumer?.maxRetries).toBe(5)
			expect(queue.options.consumer?.deadLetterQueue).toBe('stage-operations-ingest-dlq')
		}
	})

	test.each([
		['legacy', 'operations', 'operations-proxy', 'operations-payloads', 'operations-ingest', 'operations-ingest-dlq', 'propustka-worker'],
		[
			'fabrika',
			'fabrika-operations',
			'fabrika-operations-proxy',
			'fabrika-operations-payloads',
			'fabrika-operations-ingest',
			'fabrika-operations-ingest-dlq',
			'fabrika-iam',
		],
	])('FABRIKA_CLOUDFLARE_NAMES=%p names every resource', (scheme, workerName, proxyName, payloads, ingest, dlq, iam) => {
		withNames(scheme, () => {
			const proxy = config.resources({ env: 'prod', domain: 'errors.example.test' })
			expect(proxy.options.name).toBe(proxyName)
			expect(remoteService(binding(proxy, 'IAM'), 'prod')).toBe(`prod-${iam}`)
			const worker = application(proxy)
			expect(worker.options.name).toBe(workerName)
			expect(nameOf(binding(worker, 'DB'))).toBe(workerName)
			expect(nameOf(binding(worker, 'PAYLOADS'))).toBe(payloads)
			expect(nameOf(binding(worker, 'INGEST_QUEUE'))).toBe(ingest)
			expect(nameOf(binding(worker, 'INGEST_DLQ'))).toBe(dlq)
			const queue = binding(worker, 'INGEST_QUEUE')
			if (!(queue instanceof Queue)) throw new Error('INGEST_QUEUE must be a queue')
			expect(queue.options.consumer?.deadLetterQueue).toBe(`prod-${dlq}`)
			expect(remoteService(binding(worker, 'IAM'), 'prod')).toBe(`prod-${iam}`)
		})
	})

	test('keeps `process.env` and the importable `env` empty', () => {
		const flags = buildOperationsWorker({ env: 'stage' }).options.compatibility_flags
		expect(flags).toContain(NO_PROCESS_ENV_FLAG)
		expect(flags).toContain(NO_IMPORTABLE_ENV_FLAG)
	})

	test('the local composition binds IAM too and keeps no public route — there is no local auth mode', () => {
		const worker = buildOperationsWorker({ env: 'local' })
		expect(binding(worker, 'IAM')).toBeInstanceOf(ServiceReference)
		expect(worker.options.vars?.['FABRIKA_IAM_ISSUER']).toBe('http://localhost:18191')
		expect(worker.options.routes).toEqual([])
	})
})
