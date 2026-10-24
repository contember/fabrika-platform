import { describe, expect, test } from 'bun:test'
import { DATA_OPERATION_MAX_PAGE_SIZE, dataOperationListInputSchema, recoverDataOperationInputSchema, startDataOperationInputSchema } from '../rpc'

const environment = { appId: 'crm', env: 'prod' }

describe('the data operation requests (ADR-0069 §2, §3)', () => {
	test('a list names one environment and bounds one page', () => {
		expect(dataOperationListInputSchema.parse(environment)).toEqual(environment)
		expect(dataOperationListInputSchema.parse({ ...environment, before: 'op-2', limit: DATA_OPERATION_MAX_PAGE_SIZE })).toEqual({
			...environment,
			before: 'op-2',
			limit: DATA_OPERATION_MAX_PAGE_SIZE,
		})
		for (
			const value of [
				{ appId: 'crm' },
				{ ...environment, env: '' },
				{ ...environment, limit: 0 },
				{ ...environment, limit: DATA_OPERATION_MAX_PAGE_SIZE + 1 },
				{ ...environment, limit: 1.5 },
				{ ...environment, state: 'running' },
			]
		) {
			expect(dataOperationListInputSchema.safeParse(value).success).toBe(false)
		}
	})

	test('a maintenance start names its mode; a backup names none', () => {
		for (const mode of ['open', 'read-only', 'closed', 'inspect'] as const) {
			expect(startDataOperationInputSchema.parse({ ...environment, kind: 'maintenance', mode })).toEqual({ ...environment, kind: 'maintenance', mode })
		}
		expect(startDataOperationInputSchema.parse({ ...environment, kind: 'backup' })).toEqual({ ...environment, kind: 'backup' })
		for (
			const value of [
				{ ...environment, kind: 'maintenance' },
				{ ...environment, kind: 'maintenance', mode: 'frozen' },
				{ ...environment, kind: 'backup', mode: 'read-only' },
				{ ...environment, kind: 'maintenance', mode: 'closed', generation: 7 },
				// A migration runs inside a deploy, and a recovery has its own request.
				{ ...environment, kind: 'migrate' },
				{ ...environment, kind: 'recovery' },
			]
		) {
			expect(startDataOperationInputSchema.safeParse(value).success).toBe(false)
		}
	})

	test('a recovery names the stuck operation and what follows the fence', () => {
		for (const resolution of ['resume', 'open'] as const) {
			const value = { ...environment, operationId: 'op-1', resolution }
			expect(recoverDataOperationInputSchema.parse(value)).toEqual(value)
		}
		for (
			const value of [
				{ ...environment, operationId: 'op-1' },
				{ ...environment, operationId: '', resolution: 'open' },
				{ ...environment, operationId: 'op-1', resolution: 'rewind' },
				{ ...environment, operationId: 'op-1', resolution: 'open', generation: 9 },
			]
		) {
			expect(recoverDataOperationInputSchema.safeParse(value).success).toBe(false)
		}
	})
})
