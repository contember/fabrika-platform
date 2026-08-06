import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { appCliRunnerFromModule, parseCliArgs, providerFromConfig, runCli } from '..'

const zeropsConfig = resolve(import.meta.dir, '../../../../examples/zerops-app/fabrika.config.ts')

describe('unified CLI parsing', () => {
	test('extracts the command area, command, provider, and provider-owned arguments', () => {
		expect(parseCliArgs(['app', 'build', '--provider=zerops', '--env=prod', '--output=artifact.json'])).toEqual({
			area: 'app',
			command: 'build',
			provider: 'zerops',
			rest: ['--env=prod', '--output=artifact.json'],
			help: false,
		})
	})

	test('keeps positional provider arguments after the command', () => {
		expect(parseCliArgs(['platform', 'init', '--provider=cloudflare', 'acme'])).toEqual({
			area: 'platform',
			command: 'init',
			provider: 'cloudflare',
			rest: ['acme'],
			help: false,
		})
	})
})

describe('provider inference', () => {
	test('reads the provider tag produced by defineApp()', async () => {
		expect(await providerFromConfig([`--config=${zeropsConfig}`])).toBe('zerops')
	})

	test('dispatches by the inferred provider before loading provider tooling', async () => {
		await expect(runCli(['app', 'deploy', `--config=${zeropsConfig}`])).rejects.toThrow(
			'Zerops app tooling does not support `app deploy`',
		)
	})

	test('rejects an explicit provider that conflicts with defineApp()', async () => {
		await expect(runCli(['app', 'deploy', '--provider=cloudflare', `--config=${zeropsConfig}`])).rejects.toThrow(
			'App config belongs to provider "zerops", but --provider=cloudflare was requested.',
		)
	})
})

describe('runtime module validation', () => {
	test('accepts only the named async CLI runner export', async () => {
		const calls: string[][] = []
		const run = async (argv: readonly string[]): Promise<void> => {
			calls.push([...argv])
		}
		const loaded = appCliRunnerFromModule({ run }, '@vendor/provider/cli', 'run')
		await loaded(['build'])
		expect(calls).toEqual([['build']])
	})

	test('rejects missing and non-function exports', () => {
		expect(() => appCliRunnerFromModule({}, '@vendor/provider/cli', 'run')).toThrow('must export `run`')
		expect(() => appCliRunnerFromModule({ run: 'no' }, '@vendor/provider/cli', 'run')).toThrow(
			'must export `run` as a function',
		)
	})
})

describe('installation capabilities', () => {
	test('routes every Zerops platform command to the provider, argument parsing included', async () => {
		// Each rejection below comes from the INSTALLATION's own argument parsing, not from this router —
		// which is what proves the routing reached it. `init` scaffolds the operator's sidecar repository
		// and `deploy` runs the whole ordered sequence; neither creates an installation.
		await expect(runCli(['platform', 'init', '--provider=zerops'])).rejects.toThrow('requires an installation name')
		await expect(runCli(['platform', 'deploy', '--provider=zerops'])).rejects.toThrow('FABRIKA_ZEROPS_PROJECT_ID')
	})

	test('`--help` on a platform command shows the INSTALLATION surface, not this router', async () => {
		const lines: string[] = []
		const info = console.info
		console.info = (message?: unknown): void => void lines.push(String(message))
		try {
			await runCli(['platform', 'deploy', '--provider=zerops', '--help'])
		} finally {
			console.info = info
		}
		expect(lines.join('\n')).toContain('--project-id')
		expect(lines.join('\n')).not.toContain('fabrika — application platform CLI')
	})
})
