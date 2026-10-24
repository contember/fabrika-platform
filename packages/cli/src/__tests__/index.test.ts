import { generatedEntry } from '@fabrika/app/build'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseCliArgs, providerFromConfig, runCli } from '..'

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

	test('routes builder arguments through the builder namespace', () => {
		expect(parseCliArgs(['builder', 'gate', 'open', 'vision', '--view', 'vision.jsx'])).toEqual({
			area: 'builder',
			command: 'gate',
			provider: undefined,
			rest: ['open', 'vision', '--view', 'vision.jsx'],
			help: false,
		})
	})

	test('shows builder-specific help', async () => {
		const lines: string[] = []
		const info = console.info
		console.info = (message?: unknown): void => void lines.push(String(message))
		try {
			await runCli(['builder', '--help'])
		} finally {
			console.info = info
		}
		expect(lines.join('\n')).toContain('fabrika builder init')
		expect(lines.join('\n')).not.toContain('fabrika platform install')
	})
})

describe('provider inference', () => {
	test('reads the provider tag produced by defineApp()', async () => {
		expect(await providerFromConfig([`--config=${zeropsConfig}`])).toBe('zerops')
	})

	test("dispatches by the inferred provider, and the provider's own CLI module answers what it does not offer", async () => {
		await expect(runCli(['app', 'deploy', `--config=${zeropsConfig}`])).rejects.toThrow(
			'zerops app tooling does not support `app deploy`',
		)
	})

	test('rejects an explicit provider that conflicts with defineApp()', async () => {
		await expect(runCli(['app', 'deploy', '--provider=cloudflare', `--config=${zeropsConfig}`])).rejects.toThrow(
			'App config belongs to provider "zerops", but --provider=cloudflare was requested.',
		)
	})
})

describe('app build for a contract application', () => {
	const withRoot = async (contract: boolean, run: (config: string, root: string) => Promise<void>): Promise<void> => {
		const root = mkdtempSync(join(tmpdir(), 'fabrika-cli-'))
		const stderr = console.error
		console.error = () => {}
		try {
			if (contract) {
				writeFileSync(join(root, 'fabrika.contract.ts'), 'export {}\n')
			}
			await run(join(root, 'fabrika.config.ts'), root)
		} finally {
			console.error = stderr
			rmSync(root, { recursive: true, force: true })
		}
	}

	test('writes the Worker entrypoint next to fabrika.contract.ts on Cloudflare', async () => {
		await withRoot(true, async (config, root) => {
			await runCli(['app', 'build', '--provider=cloudflare', `--config=${config}`])
			expect(readFileSync(join(root, 'fabrika', 'entry.generated.ts'), 'utf8')).toBe(generatedEntry('cloudflare'))
		})
	})

	test('still refuses app build on Cloudflare for an application without a contract', async () => {
		await withRoot(false, async (config, root) => {
			await expect(runCli(['app', 'build', '--provider=cloudflare', `--config=${config}`])).rejects.toThrow(
				'Cloudflare app tooling does not support `app build`',
			)
			expect(existsSync(join(root, 'fabrika'))).toBe(false)
		})
	})
})

describe('provider CLI modules', () => {
	test('a provider without namespaces answers that it has none, from its own module', async () => {
		await expect(runCli(['namespace', 'plan', '--provider=cloudflare'])).rejects.toThrow('Provider cloudflare does not expose deployment namespaces')
	})

	test('app and namespace commands take a provider id, never a module specifier', async () => {
		await expect(runCli(['namespace', 'plan', '--provider=@vendor/provider/cli'])).rejects.toThrow('takes a provider id')
	})

	test('names the package to add when the provider CLI package is not installed', async () => {
		await expect(runCli(['namespace', 'plan', '--provider=nonexistent'])).rejects.toThrow(
			'`fabrika namespace` needs @fabrika/provider-nonexistent, which is not installed.',
		)
	})

	test("`namespace --help` with a provider shows the provider's commands", async () => {
		const lines: string[] = []
		const info = console.info
		console.info = (message?: unknown): void => void lines.push(String(message))
		try {
			await runCli(['namespace', '--provider=zerops', '--help'])
		} finally {
			console.info = info
		}
		expect(lines.join('\n')).toContain('--preset=<cheap|mid|full>')
	})
})

describe('installation capabilities', () => {
	test('routes every Zerops platform command to the provider, argument parsing included', async () => {
		// Each rejection below comes from the INSTALLATION's own argument parsing, not from this router —
		// which is what proves the routing reached it. `init` scaffolds the operator's sidecar repository
		// and `deploy` runs the whole ordered sequence; neither creates an installation.
		await expect(runCli(['platform', 'init', '--provider=zerops'])).rejects.toThrow('requires an installation name')
		await expect(runCli(['platform', 'deploy', '--provider=zerops', '--source-dir=fixture-checkout'])).rejects.toThrow('FABRIKA_ZEROPS_PROJECT_ID')
	})

	test('routes `platform admin` generically, and Cloudflare answers that it does not offer it', async () => {
		// Routing is the contract's job, not this router's: `admin` reaches the Zerops installation because
		// it declares the capability, and the same call against Cloudflare prints that provider's usage.
		await expect(runCli(['platform', 'admin', '--provider=zerops', '--email=operator@example.test'])).rejects.toThrow(
			'FABRIKA_PLATFORM_IAM_HOST',
		)
		await expect(runCli(['platform', 'admin', '--provider=cloudflare'])).rejects.toThrow(
			'cloudflare installation does not support `platform admin`',
		)
	})

	test('routes `platform upgrade` the same way, and Cloudflare needs no code to refuse it', async () => {
		// The contract gained a verb; Cloudflare's `commands` did not, so the router answers with that
		// provider's usage and no Cloudflare code was written for `upgrade` at all.
		await expect(runCli(['platform', 'upgrade', '--provider=zerops', '--to=main', 'test'])).rejects.toThrow('is not a published tag')
		await expect(runCli(['platform', 'upgrade', '--provider=cloudflare'])).rejects.toThrow(
			'cloudflare installation does not support `platform upgrade`',
		)
	})

	test('forwards a value-less provider flag verbatim, `--yes` included', async () => {
		expect(parseCliArgs(['platform', 'install', '--provider=zerops', '--yes'])).toEqual({
			area: 'platform',
			command: 'install',
			provider: 'zerops',
			rest: ['--yes'],
			help: false,
		})
		// And the installation accepts it: this rejection is the missing project id, not `--yes` being
		// refused as an unknown option, which is what an unrouted flag would produce.
		await expect(runCli(['platform', 'install', '--provider=zerops', '--yes', '--source-dir=fixture-checkout'])).rejects.toThrow(
			'FABRIKA_ZEROPS_PROJECT_ID',
		)
	})

	test('names the package to add when the installation package is not installed', async () => {
		// The builder and the providers are optional peers resolved the same way; the release pack witness runs
		// `fabrika builder` in an application without @fabrika/builder.
		await expect(runCli(['platform', 'init', '--provider=@fabrika/not-installed/installation'])).rejects.toThrow(
			'`fabrika platform init --provider=@fabrika/not-installed/installation` needs @fabrika/not-installed, which is not installed. '
				+ 'Add it: bun add -d @fabrika/not-installed',
		)
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
