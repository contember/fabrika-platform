import { describe, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
	assertPackedImports,
	assertStandaloneCheckout,
	awaitRegistryTag,
	entryImportSmoke,
	LOCAL_INSTALL_FILE,
	LOCAL_TARBALL_DIRECTORY,
	localInstallBlock,
	localVersion,
	packageInfo,
	parseOptions,
	parseReleaseManifest,
	REGISTRY_BACKOFF_MS,
	REGISTRY_DEADLINE_MS,
	type RegistryWaitDeps,
	rewriteExamplePins,
	stagedAppSkill,
	unifiedDiff,
} from '../release'

interface Clock {
	readonly slept: number[]
	readonly reported: string[]
	readonly deps: (lookup: (name: string) => Promise<string | undefined>) => RegistryWaitDeps
}

const clock = (): Clock => {
	const slept: number[] = []
	const reported: string[] = []
	let current = 0
	return {
		slept,
		reported,
		deps: (lookup) => ({
			lookup,
			sleep: async (ms) => {
				slept.push(ms)
				current += ms
			},
			now: () => current,
			report: (message) => {
				reported.push(message)
			},
		}),
	}
}

const NAMES = ['@fabrika/app', '@fabrika/cli', '@fabrika/engine']

describe('registry dist-tag wait', () => {
	test('spends nothing when every package is already replicated', async () => {
		const time = clock()
		const looked: string[] = []

		await awaitRegistryTag(
			NAMES,
			'latest',
			'0.0.26',
			time.deps(async (name) => {
				looked.push(name)
				return '0.0.26'
			}),
		)

		expect(looked).toEqual(NAMES)
		expect(time.slept).toEqual([])
		expect(time.reported).toEqual([])
	})

	test('accepts a dist-tag that has already moved past this release', async () => {
		const time = clock()

		await awaitRegistryTag(['@fabrika/app'], 'latest', '0.0.26', time.deps(async () => '0.0.27'))

		expect(time.slept).toEqual([])
	})

	test('backs off, names only the packages still missing, and re-looks-up nothing else', async () => {
		const time = clock()
		const looked: string[] = []
		let round = 0
		const lookup = async (name: string): Promise<string | undefined> => {
			looked.push(`${round}:${name}`)
			if (name === '@fabrika/app') return '0.0.26'
			if (name === '@fabrika/cli') return round >= 1 ? '0.0.26' : '0.0.25'
			return round >= 3 ? '0.0.26' : undefined
		}
		const deps = time.deps(lookup)

		await awaitRegistryTag(NAMES, 'latest', '0.0.26', {
			...deps,
			sleep: async (ms) => {
				round++
				await deps.sleep(ms)
			},
		})

		// Round 0 asks about all three; every later round asks only about what was still behind.
		expect(looked).toEqual([
			'0:@fabrika/app',
			'0:@fabrika/cli',
			'0:@fabrika/engine',
			'1:@fabrika/cli',
			'1:@fabrika/engine',
			'2:@fabrika/engine',
			'3:@fabrika/engine',
		])
		expect(time.slept).toEqual([5_000, 10_000, 20_000])
		expect(time.reported).toEqual([
			'npm dist-tag latest is not at 0.0.26 yet for 2 package(s); retrying in 5s: @fabrika/cli: 0.0.25, @fabrika/engine: (missing)',
			'npm dist-tag latest is not at 0.0.26 yet for 1 package(s); retrying in 10s: @fabrika/engine: (missing)',
			'npm dist-tag latest is not at 0.0.26 yet for 1 package(s); retrying in 20s: @fabrika/engine: (missing)',
		])
	})

	test('keeps waiting through a failing lookup and says so, instead of ending the wait on one registry error', async () => {
		const time = clock()
		let round = 0
		const deps = time.deps(async () => {
			if (round < 2) throw new Error(`npm view failed (1)\nnpm error code E500\nnpm error 500 Internal Server Error`)
			return '0.0.26'
		})

		await awaitRegistryTag(['@fabrika/app'], 'latest', '0.0.26', {
			...deps,
			sleep: async (ms) => {
				round++
				await deps.sleep(ms)
			},
		})

		expect(time.slept).toEqual([5_000, 10_000])
		expect(time.reported).toEqual([
			'npm dist-tag latest is not at 0.0.26 yet for 1 package(s); retrying in 5s: @fabrika/app: (lookup failed: npm view failed (1))',
			'npm dist-tag latest is not at 0.0.26 yet for 1 package(s); retrying in 10s: @fabrika/app: (lookup failed: npm view failed (1))',
		])
	})

	test('reports the reason when a lookup never stops failing, rather than a bare missing', async () => {
		const time = clock()

		await expect(awaitRegistryTag(['@fabrika/app'], 'latest', '0.0.26', time.deps(() => Promise.reject(new Error('ECONNRESET')))))
			.rejects.toThrow('@fabrika/app: expected npm dist-tag latest at 0.0.26 or newer, received (lookup failed: ECONNRESET)')
	})

	test('gives up at the ten-minute deadline with one line per package, as before', async () => {
		const time = clock()

		await expect(
			awaitRegistryTag(
				['@fabrika/app', '@fabrika/cli'],
				'latest',
				'0.0.26',
				time.deps(async (name) => name === '@fabrika/cli' ? '0.0.25' : undefined),
			),
		).rejects.toThrow(
			'@fabrika/app: expected npm dist-tag latest at 0.0.26 or newer, received (missing)\n@fabrika/cli: expected npm dist-tag latest at 0.0.26 or newer, received 0.0.25',
		)

		expect(time.slept.slice(0, 5)).toEqual([...REGISTRY_BACKOFF_MS, 30_000])
		expect(time.slept.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(REGISTRY_DEADLINE_MS)
		expect(time.slept.reduce((total, ms) => total + ms, 0)).toBeGreaterThan(REGISTRY_DEADLINE_MS - 30_000)
	})
})

describe('command line', () => {
	test('takes a checkout path for example-pin', async () => {
		const options = await parseOptions(['example-pin', './checkout', '--tag=v1.2.3'])

		expect(options.positional).toEqual(['./checkout'])
		expect(options.version).toBe('1.2.3')
	})

	test('refuses a stray word on a command that publishes, so a typo cannot become a release', async () => {
		await expect(parseOptions(['publish', 'oops', '--tag=v1.2.3'])).rejects.toThrow('Unknown option: oops')
		await expect(parseOptions(['registry-smoke', 'oops', '--tag=v1.2.3'])).rejects.toThrow('Unknown option: oops')
		await expect(parseOptions(['example-pin', '--nope', '--tag=v1.2.3'])).rejects.toThrow('Unknown option: --nope')
	})

	test('takes --local for pack only, and with no tag, since a local pack derives its version', async () => {
		await expect(parseOptions(['publish', '--local', '--tag=v1.2.3'])).rejects.toThrow('Unknown option: --local')
		await expect(parseOptions(['smoke', '--local', '--tag=v1.2.3'])).rejects.toThrow('Unknown option: --local')
		await expect(parseOptions(['pack', '--local', '--tag=v1.2.3'])).rejects.toThrow('pack --local derives its version and takes no --tag')
	})
})

describe('a local pack', () => {
	test('is a prerelease of the last published version, named after the commit', () => {
		expect(localVersion('0.3.3', 'abc1234')).toBe('0.3.3-local.gabc1234')
		expect(() => localVersion('0.3.3-next.1', 'abc1234')).toThrow('is not a release')
		expect(() => localVersion('0.3.3', 'HEAD')).toThrow('is not a git object name')
	})

	test('is a version the release tag parser accepts, an all-digit commit with a leading zero included', async () => {
		const version = localVersion('0.3.3', '0123456')
		expect(version).toBe('0.3.3-local.g0123456')
		expect((await parseOptions(['validate', `--tag=v${version}`])).version).toBe(version)
	})

	test('installs from vendor/: every package a direct dependency and an override', () => {
		const packages = [
			{ name: '@fabrika/app', filename: 'fabrika-app-0.3.3-local.gabc1234.tgz', dependencies: [], integrity: 'sha512-AAAA' },
			{ name: '@fabrika/db', filename: 'fabrika-db-0.3.3-local.gabc1234.tgz', dependencies: ['@fabrika/app'], integrity: 'sha512-BBBB' },
		]
		const tarballs = {
			'@fabrika/app': 'file:vendor/fabrika-app-0.3.3-local.gabc1234.tgz',
			'@fabrika/db': 'file:vendor/fabrika-db-0.3.3-local.gabc1234.tgz',
		}
		expect(localInstallBlock(packages)).toEqual({ dependencies: tarballs, overrides: tarballs })
	})

	test("leaves the skill's example pins at the published version npm has, and names the pack in SKILL.md", () => {
		const files = [
			{ path: 'SKILL.md', text: '---\nname: fabrika-app\nversion: 0.0.4\ndescription: rules\n---\n' },
			{ path: 'references/app-setup.md', text: '\t\t"@fabrika/app": "^0.0.4",\n' },
		]
		expect(stagedAppSkill(files, '0.3.3-local.gabc1234', '0.3.3')).toEqual([
			{ path: 'SKILL.md', text: '---\nname: fabrika-app\nversion: 0.3.3-local.gabc1234\ndescription: rules\n---\n' },
			{ path: 'references/app-setup.md', text: '\t\t"@fabrika/app": "^0.3.3",\n' },
		])
	})
})

const ROOT = join(import.meta.dir, '..', '..')
const runPackWitness = process.env['FABRIKA_TEST_RELEASE_PACK'] === '1'
if (!runPackWitness) {
	console.warn('release.test.ts: the local pack witness skipped: set FABRIKA_TEST_RELEASE_PACK=1 to pack, install and check (needs npm and minutes)')
}

const exec = async (
	command: readonly string[],
	cwd: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
	const child = Bun.spawn([...command], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
	const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { code, stdout, stderr }
}

describe.skipIf(!runPackWitness)('an application outside the repository on a local pack', () => {
	test('installs the set from the written block and passes fabrika-check --packed, and fails it without', async () => {
		const scratch = await mkdtemp(join(tmpdir(), 'fabrika-local-pack-'))
		try {
			const artifacts = join(scratch, 'artifacts')
			const packed = await exec(['bun', 'scripts/release.ts', 'pack', '--local', `--artifacts=${artifacts}`], ROOT)
			expect(packed.stderr).toBe('')
			expect(packed.code).toBe(0)
			const manifestPath = join(artifacts, 'release-manifest.json')
			const manifest = parseReleaseManifest(await readFile(manifestPath, 'utf8'), manifestPath)
			expect(manifest.version).toMatch(/^\d+\.\d+\.\d+-local\.g[0-9a-f]+$/)
			const block = z.object({ dependencies: z.record(z.string()), overrides: z.record(z.string()) })
				.parse(JSON.parse(await readFile(join(artifacts, LOCAL_INSTALL_FILE), 'utf8')))
			expect(block).toEqual(localInstallBlock(manifest.packages))

			const application = join(scratch, 'notes')
			await mkdir(join(application, LOCAL_TARBALL_DIRECTORY), { recursive: true })
			for (const name of (await readdir(artifacts)).filter((name) => name.endsWith('.tgz'))) {
				await cp(join(artifacts, name), join(application, LOCAL_TARBALL_DIRECTORY, name))
			}
			await writeFile(join(application, 'package.json'), `${JSON.stringify({ name: 'notes', private: true, type: 'module', ...block }, null, '\t')}\n`)
			const installed = await exec(['bun', 'install', '--ignore-scripts'], application)
			expect(installed.code).toBe(0)

			const checker = join(application, 'node_modules', '.bin', 'fabrika-check')
			const accepted = await exec([checker, '--packed', manifestPath, application], application)
			expect({ code: accepted.code, stdout: accepted.stdout }).toEqual({ code: 0, stdout: '' })
			const refused = await exec([checker, application], application)
			expect(refused.code).toBe(1)
			const rules = refused.stdout.split('\n').filter((line) => line !== '').map((line) => line.split(' ')[1])
			// One refusal per package in each of dependencies and bun.lock, and one for overrides.
			expect(rules).toEqual(Array.from({ length: manifest.packages.length * 2 + 1 }, () => 'package-replacement'))
		} finally {
			await rm(scratch, { recursive: true, force: true })
		}
	}, 900_000)
})

const EXAMPLE_MANIFEST = `{
	"name": "@fabrika/example-zerops-app",
	"private": true,
	"dependencies": {
		"@fabrika/app": "^0.0.4",
		"@fabrika/auth-core": "^0.0.4",
		"@sentry/browser": "10.69.0",
		"jose": "^5.9.0"
	},
	"devDependencies": {
		"@fabrika/cli": "^0.0.26",
		"typescript": "^5.9.3"
	}
}
`

describe('pinning an example checkout to a released version', () => {
	test('rewrites every fabrika range and leaves every other dependency alone', () => {
		const rewrite = rewriteExamplePins(EXAMPLE_MANIFEST, '0.0.26')

		expect(rewrite.changed).toBe(2)
		expect(rewrite.text).toContain('"@fabrika/app": "^0.0.26",')
		expect(rewrite.text).toContain('"@fabrika/auth-core": "^0.0.26",')
		expect(rewrite.text).toContain('"@sentry/browser": "10.69.0",')
		expect(rewrite.text).toContain('"jose": "^5.9.0"')
		expect(rewrite.text.split('\n')).toHaveLength(EXAMPLE_MANIFEST.split('\n').length)
	})

	test('is a no-op the second time, so a re-run produces no diff', () => {
		const once = rewriteExamplePins(EXAMPLE_MANIFEST, '0.0.26')

		expect(rewriteExamplePins(once.text, '0.0.26')).toEqual({ text: once.text, changed: 0 })
		expect(unifiedDiff('package.json', once.text, once.text)).toBe('')
	})

	test('leaves a workspace range alone, so pointing it at a monorepo member cannot unlink it', () => {
		const manifest = '{\n\t"dependencies": {\n\t\t"@fabrika/app": "workspace:*"\n\t}\n}\n'

		expect(rewriteExamplePins(manifest, '0.0.26')).toEqual({ text: manifest, changed: 0 })
	})

	test('refuses a checkout inside this repository, where a pin keeps bun linking the workspace', () => {
		expect(() => assertStandaloneCheckout('/repo/examples/zerops-app', '/repo')).toThrow('is inside this repository')
		expect(() => assertStandaloneCheckout('/repo/examples/zerops-app', '/repo')).toThrow('fetch from npm instead')
		expect(() => assertStandaloneCheckout('/repo', '/repo')).toThrow('is inside this repository')
	})

	test('accepts a standalone checkout, including one whose path merely starts like this repository', () => {
		expect(() => assertStandaloneCheckout('/tmp/fabrika-example-checkout', '/repo')).not.toThrow()
		expect(() => assertStandaloneCheckout('/repo-elsewhere/example', '/repo')).not.toThrow()
	})

	test('prints a unified diff of the pin lines with their surrounding context', () => {
		const rewrite = rewriteExamplePins(EXAMPLE_MANIFEST, '0.0.26')

		expect(unifiedDiff('package.json', EXAMPLE_MANIFEST, rewrite.text)).toBe(
			[
				'--- a/package.json',
				'+++ b/package.json',
				'@@ -2,8 +2,8 @@',
				'\t"name": "@fabrika/example-zerops-app",',
				'\t"private": true,',
				'\t"dependencies": {',
				'-\t\t"@fabrika/app": "^0.0.4",',
				'-\t\t"@fabrika/auth-core": "^0.0.4",',
				'+\t\t"@fabrika/app": "^0.0.26",',
				'+\t\t"@fabrika/auth-core": "^0.0.26",',
				'\t\t"@sentry/browser": "10.69.0",',
				'\t\t"jose": "^5.9.0"',
				'\t},',
			].map((line, index) => index < 3 || line.startsWith('-') || line.startsWith('+') ? line : ` ${line}`).join('\n'),
		)
	})

	test('refuses to diff a rewrite that added or removed a line, because the caller cannot produce one', () => {
		expect(() => unifiedDiff('package.json', 'a\nb\n', 'a\nb\nc\n')).toThrow('the pin rewrite changed the line count')
	})
})

describe('the tarball smoke loads every public main entry', () => {
	const installPackage = async (consumer: string, name: string, source: string): Promise<void> => {
		const directory = join(consumer, 'node_modules', ...name.split('/'))
		await mkdir(directory, { recursive: true })
		await writeFile(join(directory, 'package.json'), JSON.stringify({ name, type: 'module', exports: { '.': './index.ts' } }))
		await writeFile(join(directory, 'index.ts'), source)
	}

	const runSmoke = async (packageNames: readonly string[], packages: Readonly<Record<string, string>>) => {
		const consumer = await mkdtemp(join(tmpdir(), 'fabrika-entry-smoke-'))
		try {
			for (const [name, source] of Object.entries(packages)) await installPackage(consumer, name, source)
			await writeFile(join(consumer, 'smoke.ts'), entryImportSmoke(packageNames))
			const child = Bun.spawn(['bun', 'run', 'smoke.ts'], { cwd: consumer, stdout: 'pipe', stderr: 'pipe' })
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
			return { exitCode, stderr }
		} finally {
			await rm(consumer, { recursive: true, force: true })
		}
	}

	test('passes when every entry resolves, including a type-only one', async () => {
		const result = await runSmoke(['@fabrika/one', '@fabrika/types-only'], {
			'@fabrika/one': 'export const one = 1\n',
			'@fabrika/types-only': 'export type Only = string\n',
		})
		expect(result.exitCode).toBe(0)
	})

	test('fails and names the package whose shipped file imports an unpublished one', async () => {
		const result = await runSmoke(['@fabrika/one', '@fabrika/leaky'], {
			'@fabrika/one': 'export const one = 1\n',
			'@fabrika/leaky': "export { secret } from '@fabrika/private-only'\n",
		})
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain('@fabrika/leaky: main entry does not load from its tarball')
	})
})

describe('packed files import only what a consumer can resolve', () => {
	const PUBLIC = new Set(['@fabrika/leaky', '@fabrika/declared'])

	const fixture = async (files: Readonly<Record<string, string>>) => {
		const directory = await mkdtemp(join(tmpdir(), 'fabrika-packed-imports-'))
		const manifest = {
			name: '@fabrika/leaky',
			version: '1.0.0',
			publishConfig: { access: 'public' },
			files: ['src', '!src/**/__tests__/**'],
			exports: { '.': './src/index.ts' },
			dependencies: { '@fabrika/declared': 'workspace:*', '@fabrika/private': 'workspace:*' },
		}
		await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
		for (const [path, source] of Object.entries(files)) {
			await mkdir(join(directory, path, '..'), { recursive: true })
			await writeFile(join(directory, path), source)
		}
		return { directory, item: packageInfo(JSON.stringify(manifest), directory) }
	}

	const check = async (files: Readonly<Record<string, string>>): Promise<unknown> => {
		const { directory, item } = await fixture(files)
		try {
			return await assertPackedImports(item, PUBLIC).then(() => undefined, (error: unknown) => error)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	}

	test('accepts declared public dependencies, self-imports and imports inside the package', async () => {
		const error = await check({
			'src/index.ts': "export { a } from './nested/a'\nimport type { D } from '@fabrika/declared/sub'\nimport '@fabrika/leaky/other'\n",
			'src/nested/a.ts': "export const a = 1\nimport '../index'\n",
			'src/__tests__/excluded.test.ts': "import '@fabrika/control'\n",
			'outside.ts': "import '@fabrika/control'\n",
		})
		expect(error).toBeUndefined()
	})

	test('names the file and specifier of every leak, type-only ones included', async () => {
		const error = await check({
			'src/index.ts': "import type { Gates } from '@fabrika/control/gates'\n",
			'src/nested/a.ts': "import { b } from '../../../elsewhere/src/b'\nimport { p } from '@fabrika/private'\n",
		})
		expect(error).toBeInstanceOf(Error)
		const message = error instanceof Error ? error.message : ''
		expect(message).toContain('src/index.ts imports @fabrika/control/gates, which is not a declared dependency')
		expect(message).toContain('src/nested/a.ts imports ../../../elsewhere/src/b, which is outside the package')
		expect(message).toContain('src/nested/a.ts imports @fabrika/private, which is a private package')
	})
})
