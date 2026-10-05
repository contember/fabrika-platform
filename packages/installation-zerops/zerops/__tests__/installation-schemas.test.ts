import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { importSchema, zeropsYamlSchema } from '../installation-schemas'
import { parseYaml, validateYaml } from '../validate'

const valid: z.input<typeof importSchema> = {
	project: { name: 'p', envIsolation: 'service', corePackage: 'SERIOUS' },
	services: [{ hostname: 'api', type: 'alpine/bun@1.3', envIsolation: 'service', override: true }],
}
test('the parsed installation retains its fields', () => {
	expect(importSchema.parse(valid)).toEqual(valid)
})
describe('installation import rejection fixtures', () => {
	for (
		const service of [
			{ type: 'alpine/bun@1.3' },
			{ hostname: 'api', type: 'alpine/bun@1.3', enableSubdomainAcces: true },
			{ hostname: 'api', type: 'alpine/bun@9.9' },
			{ hostname: 'api', type: 'alpine/bun@1.3', priority: 'high' },
			{ hostname: 'api', type: 'alpine/bun@1.3', maxContainers: 40 },
			{ hostname: 'api', type: 'alpine/bun@1.3', minContainers: 0 },
			{ hostname: 'api', type: 'alpine/bun@1.3', profile: 'oltp-staging' },
			{ hostname: 'api', type: 'alpine/bun@1.3', verticalAutoscaling: { ram: 0.1 } },
			{ hostname: 'db', type: 'postgresql:ha@18', profile: 'hobby' },
			{ hostname: 'db', type: 'postgresql:ha@18', profile: 'oltp-hobby' },
			{ hostname: 'db', type: 'postgresql:single@18', profile: 'oltp-enterprise' },
			{ hostname: 'db', type: 'postgresql:ha@18', profile: 'oltp-production', profileOverrides: { work_mem: 2 } },
			{ hostname: 'db', type: 'postgresql:ha@18', profile: 'custom', profileOverrides: { cpu: 2 } },
			{ hostname: 'db', type: 'postgresql:ha@18', maxContainers: 3 },
			{ hostname: 'db', type: 'postgresql:ha@18', verticalAutoscaling: { ram: 0.125 } },
			{ hostname: 'storage', type: 'object-storage', maxContainers: 1 },
			{ hostname: 'storage', type: 'object-storage', verticalAutoscaling: { cpu: 1 } },
		]
	) {
		test(JSON.stringify(service), () => {
			expect(importSchema.safeParse({ services: [service] }).success).toBe(false)
		})
	}
})
test('runtime boundaries, PostgreSQL profiles and custom tuning are accepted', () => {
	const document: z.input<typeof importSchema> = {
		services: [
			{ hostname: 'api', type: 'alpine/bun@1.3', minContainers: 1, maxContainers: 10, verticalAutoscaling: { cpu: 8, ram: 0.125, disk: 250 } },
			{ hostname: 'db', type: 'postgresql:ha@18', profile: 'oltp-enterprise' },
			{ hostname: 'db2', type: 'postgresql:single@18', profile: 'oltp-hobby' },
			{ hostname: 'db3', type: 'postgresql:ha@18', profile: 'custom', profileOverrides: { work_mem: 32, random_page_cost: 1.1 } },
			{ hostname: 'storage', type: 'object-storage', verticalAutoscaling: { cpuMode: 'SHARED' } },
			{ hostname: 'db4', type: 'postgresql:single@18', profileOverrides: { legacy: true } },
		],
	}
	expect(importSchema.parse(document)).toEqual(document)
})
test('all six probe fields accept duration strings and reject integers', () => {
	for (const field of ['failureTimeout', 'retryPeriod']) {
		expect(zeropsYamlSchema.safeParse({ zerops: [{ setup: 'api', deploy: { readinessCheck: { [field]: '30s' } } }] }).success).toBe(true)
		expect(zeropsYamlSchema.safeParse({ zerops: [{ setup: 'api', deploy: { readinessCheck: { [field]: 30 } } }] }).success).toBe(false)
	}
	for (const field of ['failureTimeout', 'disconnectTimeout', 'recoveryTimeout', 'execPeriod']) {
		expect(zeropsYamlSchema.safeParse({ zerops: [{ setup: 'api', run: { healthCheck: { [field]: '30s' } } }] }).success).toBe(true)
		expect(zeropsYamlSchema.safeParse({ zerops: [{ setup: 'api', run: { healthCheck: { [field]: 30 } } }] }).success).toBe(false)
	}
})
test('build/run fields preserve scalar/list alternatives and environment scalars', () => {
	const document: z.input<typeof zeropsYamlSchema> = {
		zerops: [{
			setup: 'api',
			build: { deployFiles: ['dist'], base: ['alpine/bun@1.3'], cache: true, envVariables: { TEXT: 'x', NUMBER: 1, BOOL: false } },
			run: { envReplace: { target: 'dist', delimiter: ['a', 'b'] } },
		}],
	}
	expect(zeropsYamlSchema.parse(document)).toEqual(document)
})
test('nested build/run unknown keys and required fields are enforced', () => {
	for (
		const setup of [{ build: {} }, { run: { ports: [{}] } }, { run: { healthCheck: { httpGet: { port: 80 } } } }, { run: { startCommands: [{}] } }, {
			run: { crontab: [{ timing: '* * * * *', command: 'true' }] },
		}, { build: { deployFiles: '.', typo: true } }]
	) {
		expect(zeropsYamlSchema.safeParse({ zerops: [{ setup: 'api', ...setup }] }).success).toBe(false)
	}
})
test('YAML comments are ignored and validation uses the parsed document', () => {
	expect(parseYaml('# comment\nservices:\n  - hostname: api\n    type: alpine/bun@1.3\n')).toEqual({
		services: [{ hostname: 'api', type: 'alpine/bun@1.3' }],
	})
	expect(validateYaml('import', 'services:\n  - hostname: api\n    type: nope\n').length).toBeGreaterThan(0)
})
