import { describe, expect, test } from 'bun:test'
import {
	contractChecks,
	contractRecipe,
	type ContractRecipeInput,
	FILE_SCAN_JOB,
	FILE_SWEEP_JOB,
	PLATFORM_TYPESCRIPT_VERSION,
	SCHEMA_TYPES_CHECK,
} from '../build'

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
		expect(at("'test', '--isolate'")).toBe(1)
		expect(at('rm -rf node_modules')).toBeGreaterThan(at("'test', '--isolate'"))
		expect(at('writeGeneratedEntry')).toBeGreaterThan(at('rm -rf node_modules'))
		expect(at('tsc -p /src/fabrika/tsconfig.platform.json')).toBeGreaterThan(at('writeGeneratedEntry'))
		expect(at('fabrika-check /src')).toBeGreaterThan(at('tsc -p /src/fabrika/tsconfig.platform.json'))
		expect(steps.at(-1)).toBe('cd /tmp && bun x --bun -p @fabrika/check@0.9.1 fabrika-source-maps /src || true')
		expect(commands(contractRecipe({ ...input, sourceMaps: false })).some((step) => step.includes('fabrika-source-maps'))).toBe(false)
	})

	test("type-checks the SPA under web/ only for an application read with a 0.9 or later checker; an older one keeps 0.8's src/ check", () => {
		const included = (checkRelease: string): unknown => {
			const step = contractRecipe({ ...input, checkRelease }).build.find((candidate) =>
				'write' in candidate && candidate.write === 'fabrika/tsconfig.platform.json'
			)
			if (step === undefined || !('lines' in step)) throw new Error('the recipe writes no platform tsconfig')
			const parsed: unknown = JSON.parse(step.lines.join('\n'))
			return typeof parsed === 'object' && parsed !== null && 'include' in parsed ? parsed.include : undefined
		}
		const withWeb = ['../fabrika.contract.ts', '../src', '../web', 'entry.generated.ts']
		const withoutWeb = ['../fabrika.contract.ts', '../src', 'entry.generated.ts']
		for (const release of ['0.9.0', '0.9.0-dev.21', '0.9.1', '0.10.0', '1.0.0']) expect(included(release)).toEqual(withWeb)
		for (const release of ['0.4.8', '0.5.5', '0.6.0', '0.7.0', '0.8.2']) expect(included(release)).toEqual(withoutWeb)
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

describe('contractChecks', () => {
	test('runs the tests, tsc over the platform tsconfig, then the checker at its release, from the source root', () => {
		const { tsconfig, checks } = contractChecks('/work/run/app', '0.9.1')
		expect(checks.map((check) => check.name)).toEqual(['tests', 'tsc', 'fabrika-check'])
		expect(checks[0].command).toContain("'test', '--isolate', '--pass-with-no-tests'")
		expect(checks[0].command).toContain('fabrika-tests:')
		expect(checks[1].command).toBe(
			`cd /tmp && bun x --bun -p typescript@${PLATFORM_TYPESCRIPT_VERSION} tsc -p /work/run/app/fabrika/tsconfig.platform.json`,
		)
		expect(checks[2].command).toBe('cd /tmp && bun x --bun -p @fabrika/check@0.9.1 fabrika-check /work/run/app')
		expect(tsconfig.write).toBe('fabrika/tsconfig.platform.json')
		expect(JSON.parse(tsconfig.lines.join('\n')).include).toContain('entry.generated.ts')
	})

	test('are the checks and the tsconfig of the recipe, and the schema checks are its verify script', () => {
		const recipe = contractRecipe(input)
		const { tsconfig, checks } = contractChecks(input.sourceRoot, input.checkRelease)
		expect(recipe.checks).toEqual(checks)
		expect(recipe.build).toContainEqual(tsconfig)
		const verify = recipe.build.find((step) => 'write' in step && step.write === 'fabrika/verify.generated.sh')
		expect(verify).toEqual({
			write: 'fabrika/verify.generated.sh',
			lines: [
				'#!/bin/sh',
				'set -eu',
				'cd /app',
				`FABRIKA_APP_ID=notes exec ./node_modules/.bin/fabrika ${SCHEMA_TYPES_CHECK.join(' ')}`,
			],
		})
		expect(SCHEMA_TYPES_CHECK).toEqual(['db', 'codegen', '--verify'])
	})

	test('refuses a source root or a release a shell would read as more than one word', () => {
		expect(() => contractChecks('/work/a;id', '0.9.1')).toThrow('the source root must be an absolute path')
		expect(() => contractChecks('work/app', '0.9.1')).toThrow('the source root must be an absolute path')
		expect(() => contractChecks('/work/my app', '0.9.1')).toThrow('the source root must be an absolute path')
		expect(() => contractChecks('/work/app', '0.9.1 && id')).toThrow('the checker release must be a release version')
	})
})
