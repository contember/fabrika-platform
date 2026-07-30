import { describe, expect, test } from 'bun:test'
import { parseZeropsCliArgs } from '../cli-args'

describe('fabrika Zerops arguments', () => {
	test('parses the build command and its provider-specific artifact options', () => {
		expect(parseZeropsCliArgs(['build', '--env=prod', '--config=app.ts', '--output=artifact.json'])).toEqual({
			command: 'build',
			subcommand: undefined,
			env: 'prod',
			config: 'app.ts',
			output: 'artifact.json',
			namespaceId: undefined,
			preset: undefined,
			exclusiveAppId: undefined,
			projectId: undefined,
			projectName: undefined,
			corePackage: undefined,
			publicAccess: undefined,
			postgresType: undefined,
			postgresProfile: undefined,
			proxyBuildFromGit: undefined,
			controlUrl: undefined,
			help: false,
		})
	})

	test('parses a namespace command and its provider policy options', () => {
		expect(parseZeropsCliArgs([
			'namespace',
			'create',
			'--id=apps-prod',
			'--env=prod',
			'--preset=cheap',
			'--postgres-type=postgresql:ha@18',
			'--control-url=https://control.example.test',
		])).toMatchObject({
			command: 'namespace',
			subcommand: 'create',
			namespaceId: 'apps-prod',
			env: 'prod',
			preset: 'cheap',
			postgresType: 'postgresql:ha@18',
			controlUrl: 'https://control.example.test',
		})
	})

	test('keeps stable defaults and rejects extra input', () => {
		expect(parseZeropsCliArgs(['build', '--env=stage'])).toEqual({
			command: 'build',
			subcommand: undefined,
			env: 'stage',
			config: './fabrika.config.ts',
			output: './fabrika.manifest.json',
			namespaceId: undefined,
			preset: undefined,
			exclusiveAppId: undefined,
			projectId: undefined,
			projectName: undefined,
			corePackage: undefined,
			publicAccess: undefined,
			postgresType: undefined,
			postgresProfile: undefined,
			proxyBuildFromGit: undefined,
			controlUrl: undefined,
			help: false,
		})
		expect(() => parseZeropsCliArgs(['build', '--unknown'])).toThrow('Unknown option')
		expect(() => parseZeropsCliArgs(['build', 'extra'])).toThrow('Unexpected argument')
	})
})
