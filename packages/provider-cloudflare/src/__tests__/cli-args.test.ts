import { describe, expect, test } from 'bun:test'
import { parseCloudflareArgs, platformComponents } from '../cli-args'

describe('parseCloudflareArgs', () => {
	test('parses a provider deploy', () => {
		expect(parseCloudflareArgs(['deploy', '--env=stage', '--config=app.ts', '--managed-var=FABRIKA_RELEASE', '--dry-run'])).toEqual({
			command: 'deploy',
			subcommand: undefined,
			env: 'stage',
			config: 'app.ts',
			runnerConfig: undefined,
			workerConfig: undefined,
			managedVarNames: ['FABRIKA_RELEASE'],
			buildRunnerImage: false,
			dryRun: true,
			help: false,
		})
		expect(() => parseCloudflareArgs(['deploy', '--managed-var=not-valid'])).toThrow('Invalid --managed-var name')
	})

	test('keeps platform components in dependency order', () => {
		expect(platformComponents('runner.ts', 'control.ts')).toEqual([
			{ label: 'vozka-runner', configPath: 'runner.ts' },
			{ label: 'vozka', configPath: 'control.ts' },
		])
	})
})
