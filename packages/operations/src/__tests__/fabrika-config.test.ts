import { D1Database, Queue, R2Bucket, ServiceReference, type Worker } from '@fabrika/provider-cloudflare'
import { describe, expect, test } from 'bun:test'
import config, { buildOperationsWorker } from '../../fabrika.config'

const binding = (worker: Worker, name: string): unknown => worker.options.bindings?.[name]

describe('Operations Cloudflare composition', () => {
	test('owns persistence, payload storage, ingest queue, DLQ, cron, and IAM binding', () => {
		const worker = config.resources({ env: 'prod', domain: 'errors.example.test' })
		expect(worker.options.name).toBe('operations')
		expect(worker.options.main).toBe('./src/worker.ts')
		expect(binding(worker, 'DB')).toBeInstanceOf(D1Database)
		expect(binding(worker, 'PAYLOADS')).toBeInstanceOf(R2Bucket)
		expect(binding(worker, 'INGEST_QUEUE')).toBeInstanceOf(Queue)
		expect(binding(worker, 'INGEST_DLQ')).toBeInstanceOf(Queue)
		expect(binding(worker, 'IAM')).toBeInstanceOf(ServiceReference)
		expect(binding(worker, 'CONTROL')).toBeUndefined()
		expect(binding(worker, 'PIPELINE_METRICS')).toBeUndefined()
		expect(worker.options.vars?.['DEV']).toBe('')
		expect(worker.options.vars?.['FABRIKA_IAM_URL']).toBeDefined()
		expect(worker.options.vars?.['PROPUSTKA_URL']).toBeUndefined()
		expect(worker.options.triggers?.crons).toEqual(['* * * * *'])
		expect(worker.options.routes).toEqual([{ pattern: 'errors.example.test', custom_domain: true }])
	})

	test('the main queue exhausts into the environment-qualified DLQ', () => {
		const worker = config.resources({ env: 'stage' })
		const queue = binding(worker, 'INGEST_QUEUE')
		expect(queue).toBeInstanceOf(Queue)
		if (queue instanceof Queue) {
			expect(queue.options.consumer?.maxRetries).toBe(5)
			expect(queue.options.consumer?.deadLetterQueue).toBe('stage-operations-ingest-dlq')
		}
	})

	test('local composition omits the IAM service binding and public route', () => {
		const worker = buildOperationsWorker({ env: 'local' })
		expect(binding(worker, 'IAM')).toBeUndefined()
		expect(worker.options.vars?.['DEV']).toBe('true')
		expect(worker.options.routes).toEqual([])
	})
})
