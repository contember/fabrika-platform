import { describe, expect, test } from 'bun:test'
import { parseZeropsCliArgs } from '../cli-args'

describe('fabrika-zerops arguments', () => {
	test('parses the build command and its provider-specific artifact options', () => {
		expect(parseZeropsCliArgs(['build', '--env=prod', '--config=app.ts', '--output=artifact.json'])).toEqual({
			command: 'build',
			env: 'prod',
			config: 'app.ts',
			output: 'artifact.json',
			help: false,
		})
	})

	test('keeps stable defaults and rejects extra input', () => {
		expect(parseZeropsCliArgs(['build', '--env=stage'])).toEqual({
			command: 'build',
			env: 'stage',
			config: './fabrika.config.ts',
			output: './fabrika.manifest.json',
			help: false,
		})
		expect(() => parseZeropsCliArgs(['build', '--unknown'])).toThrow('Unknown option')
		expect(() => parseZeropsCliArgs(['build', 'extra'])).toThrow('Unexpected argument')
	})
})
