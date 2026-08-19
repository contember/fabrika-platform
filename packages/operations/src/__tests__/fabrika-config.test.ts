import { D1Database, Queue, R2Bucket, ServiceReference, Worker } from '@fabrika/provider-cloudflare'
import { describe, expect, test } from 'bun:test'
import config, { buildOperationsWorker } from '../../fabrika.config'

const binding = (worker: Worker, name: string): unknown => worker.options.bindings?.[name]

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

	test('the local composition binds IAM too and keeps no public route — there is no local auth mode', () => {
		const worker = buildOperationsWorker({ env: 'local' })
		expect(binding(worker, 'IAM')).toBeInstanceOf(ServiceReference)
		expect(worker.options.vars?.['FABRIKA_IAM_ISSUER']).toBe('http://localhost:18191')
		expect(worker.options.routes).toEqual([])
	})
})
