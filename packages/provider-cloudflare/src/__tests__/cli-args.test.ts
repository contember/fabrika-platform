import { describe, expect, test } from 'bun:test'
import { parseCloudflareArgs, platformComponents } from '../cli-args'
import { parseInstallationApps, parseReturnOrigins } from '../command'

describe('parseCloudflareArgs', () => {
	test('parses a provider deploy', () => {
		expect(parseCloudflareArgs(['deploy', '--env=stage', '--config=app.ts', '--managed-var=FABRIKA_RELEASE', '--dry-run'])).toEqual({
			command: 'deploy',
			subcommand: undefined,
			env: 'stage',
			config: 'app.ts',
			runnerConfig: undefined,
			workerConfig: undefined,
			componentConfig: undefined,
			managedVarNames: ['FABRIKA_RELEASE'],
			dryRun: true,
			help: false,
		})
		expect(() => parseCloudflareArgs(['deploy', '--managed-var=not-valid'])).toThrow('Invalid --managed-var name')
	})

	test('reads the single-component platform form', () => {
		const args = parseCloudflareArgs(['platform', 'deploy', '--env=prod', '--component-config=fabrika.config.ts'])
		expect(args.componentConfig).toBe('fabrika.config.ts')
		expect(args.runnerConfig).toBeUndefined()
		expect(args.workerConfig).toBeUndefined()
	})

	test('keeps platform components in dependency order', () => {
		expect(platformComponents({ runnerConfig: 'runner.ts', workerConfig: 'control.ts', componentConfig: undefined })).toEqual([
			{ label: 'vozka-runner', configPath: 'runner.ts' },
			{ label: 'vozka', configPath: 'control.ts' },
		])
	})

	test('the single-component form deploys exactly the config it names', () => {
		expect(platformComponents({ runnerConfig: undefined, workerConfig: undefined, componentConfig: 'packages/iam/fabrika.config.ts' }))
			.toEqual([{ label: 'packages/iam/fabrika.config.ts', configPath: 'packages/iam/fabrika.config.ts' }])
	})

	test('the two forms cannot be combined, and neither can be missing', () => {
		expect(() => platformComponents({ runnerConfig: 'runner.ts', workerConfig: 'control.ts', componentConfig: 'iam.ts' }))
			.toThrow('cannot be combined')
		expect(() => platformComponents({ runnerConfig: 'runner.ts', workerConfig: undefined, componentConfig: 'iam.ts' }))
			.toThrow('cannot be combined')
		expect(() => platformComponents({ runnerConfig: undefined, workerConfig: undefined, componentConfig: undefined }))
			.toThrow('Missing --runner-config=<path> (or --component-config=<path>)')
		expect(() => platformComponents({ runnerConfig: 'runner.ts', workerConfig: undefined, componentConfig: undefined }))
			.toThrow('Missing --worker-config=<path>')
	})
})

describe('parseReturnOrigins', () => {
	test('decodes the control plane projection out of the deploy environment', () => {
		expect(parseReturnOrigins('https://app.example.com,https://stage.app.example.com')).toEqual([
			'https://app.example.com',
			'https://stage.app.example.com',
		])
		expect(parseReturnOrigins(' https://app.example.com , ')).toEqual(['https://app.example.com'])
	})

	test('an absent or empty value leaves IAM alone rather than clearing it', () => {
		expect(parseReturnOrigins(undefined)).toBeUndefined()
		expect(parseReturnOrigins('')).toBeUndefined()
		expect(parseReturnOrigins(' , ')).toBeUndefined()
	})
})

describe('parseInstallationApps', () => {
	test('decodes the registry the runner writes, one deployment per `<app>@<env>`', () => {
		expect(parseInstallationApps('["notes@prod","crm@stage"]')).toEqual([{ app: 'notes', env: 'prod' }, { app: 'crm', env: 'stage' }])
		expect(parseInstallationApps('[]')).toEqual([])
		expect(parseInstallationApps(undefined)).toBeUndefined()
	})

	test('anything malformed fails the deploy rather than dropping the refusal it feeds', () => {
		expect(() => parseInstallationApps('notes@prod')).toThrow('FABRIKA_INSTALLATION_APPS is not a JSON array')
		expect(() => parseInstallationApps('{"notes":"prod"}')).toThrow('is not a JSON array of strings')
		expect(() => parseInstallationApps('["notes"]')).toThrow('holds `notes`, which is not `<app>@<env>`')
	})
})
