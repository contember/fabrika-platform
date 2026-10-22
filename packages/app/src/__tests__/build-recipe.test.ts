import { describe, expect, test } from 'bun:test'
import { contractRecipe, type ContractRecipeInput, FILE_SCAN_JOB, FILE_SWEEP_JOB } from '../build'

const input: ContractRecipeInput = {
	appId: 'notes',
	checkRelease: '0.9.1',
	sourceRoot: '/src',
	runtimeRoot: '/app',
	database: true,
	sourceMaps: true,
	jobs: [{ name: 'digest', schedule: '0 6 * * *' }],
	files: true,
	scan: true,
}

const commands = (recipe: ReturnType<typeof contractRecipe>): string[] => recipe.build.map((step) => 'run' in step ? step.run : `write ${step.write}`)

describe('contractRecipe', () => {
	test('runs the authored tests before everything that produces or checks what deploys, and uploads source maps last', () => {
		const steps = commands(contractRecipe(input))
		const at = (fragment: string): number => steps.findIndex((step) => step.includes(fragment))
		expect(at('bun test --isolate')).toBe(1)
		expect(at('rm -rf node_modules')).toBeGreaterThan(at('bun test'))
		expect(at('writeGeneratedEntry')).toBeGreaterThan(at('rm -rf node_modules'))
		expect(at('tsc -p /src/fabrika/tsconfig.platform.json')).toBeGreaterThan(at('writeGeneratedEntry'))
		expect(at('fabrika-check /src')).toBeGreaterThan(at('tsc -p /src/fabrika/tsconfig.platform.json'))
		expect(steps.at(-1)).toBe('cd /tmp && bun x --bun -p @fabrika/check@0.9.1 fabrika-source-maps /src || true')
		expect(commands(contractRecipe({ ...input, sourceMaps: false })).some((step) => step.includes('fabrika-source-maps'))).toBe(false)
	})

	test('a database migrates and verifies its schema before the server starts; without one nothing runs first', () => {
		const recipe = contractRecipe(input)
		expect(recipe.init).toEqual(['fabrika/migrate.generated.sh', 'fabrika/verify.generated.sh'])
		const migrate = recipe.build.find((step) => 'write' in step && step.write === 'fabrika/migrate.generated.sh')
		expect(migrate).toEqual({
			write: 'fabrika/migrate.generated.sh',
			lines: ['#!/bin/sh', 'set -eu', 'cd /app', 'FABRIKA_APP_ID=notes exec ./node_modules/.bin/fabrika db migrate'],
		})
		expect(contractRecipe({ ...input, database: false }).init).toEqual([])
		expect(recipe.start).toBe('fabrika/start.generated.sh')
	})

	test("schedules the contract's jobs and the framework's file jobs only when the contract has files and scans", () => {
		expect(contractRecipe(input).jobs).toEqual([
			{ schedule: '0 6 * * *', command: './node_modules/.bin/fabrika job run digest' },
			{ schedule: '41 * * * *', command: `./node_modules/.bin/fabrika job run ${FILE_SWEEP_JOB}` },
			{ schedule: '* * * * *', command: `./node_modules/.bin/fabrika job run ${FILE_SCAN_JOB}` },
		])
		expect(contractRecipe({ ...input, jobs: [], files: false, scan: false }).jobs).toEqual([])
	})

	test('refuses a value a shell would read as more than one word', () => {
		expect(() => contractRecipe({ ...input, appId: 'notes; rm -rf /' })).toThrow('a contract application id must match')
		expect(() => contractRecipe({ ...input, checkRelease: '0.9.1 && curl evil' })).toThrow('the checker release must be a release version')
		expect(() => contractRecipe({ ...input, jobs: [{ name: 'digest $(id)', schedule: '0 6 * * *' }] })).toThrow('a job name or schedule')
		expect(() => contractRecipe({ ...input, jobs: [{ name: 'digest', schedule: '0 6 * * * ; id' }] })).toThrow('a job name or schedule')
	})
})
