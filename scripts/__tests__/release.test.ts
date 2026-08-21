import { describe, expect, test } from 'bun:test'
import {
	assertStandaloneCheckout,
	awaitRegistryTag,
	parseOptions,
	REGISTRY_BACKOFF_MS,
	REGISTRY_DEADLINE_MS,
	type RegistryWaitDeps,
	rewriteExamplePins,
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
