import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializePlatformScaffold } from '../scaffold'

const GENERATED_FILES = ['.gitignore', 'README.md', 'fabrika.ref', '.github/workflows/platform.yml']
const FORBIDDEN_GENERATED_REFERENCES = [
	'contember/vozka',
	'contember/propustka',
	'vozka.ref',
	'propustka.ref',
	'packages/admin-ui',
	'packages/worker',
]

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'fabrika-cli-scaffold-'))
	try {
		await run(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

async function snapshot(dir: string): Promise<Record<string, string>> {
	const entries = await Promise.all(
		GENERATED_FILES.map(async (path) => [path, await Bun.file(join(dir, path)).text()] satisfies [string, string]),
	)
	return Object.fromEntries(entries)
}

describe('platform scaffold', () => {
	test('fresh creation renders one repository checkout and one source pin offline', async () => {
		await withTempDir(async (dir) => {
			await materializePlatformScaffold(dir, 'mangoweb')

			const files = await snapshot(dir)
			expect(files['fabrika.ref']).toBe('main\n')
			expect(files['README.md']).toContain('# fabrika-platform (mangoweb)')
			expect(files['.github/workflows/platform.yml']).toContain('repository: contember/fabrika-platform')
			expect(files['.github/workflows/platform.yml']).toContain('working-directory: fabrika-platform/packages/iam-ui')
			expect(files['.github/workflows/platform.yml']).toContain('working-directory: fabrika-platform/packages/iam')
			expect(files['.github/workflows/platform.yml']).toContain('--runner-config=packages/runner/fabrika-runner.config.ts')
			expect(files['.github/workflows/platform.yml']).toContain('--worker-config=packages/control/fabrika.config.ts')

			const generated = Object.values(files).join('\n')
			for (const forbidden of FORBIDDEN_GENERATED_REFERENCES) {
				expect(generated).not.toContain(forbidden)
			}
		})
	})

	test('unchanged refresh is byte-identical and preserves the operator pin', async () => {
		await withTempDir(async (dir) => {
			await materializePlatformScaffold(dir, 'mangoweb')
			await Bun.write(join(dir, 'fabrika.ref'), 'v1.2.3\n')
			const before = await snapshot(dir)

			await materializePlatformScaffold(dir, 'mangoweb')

			expect(await snapshot(dir)).toEqual(before)
		})
	})

	test('legacy two-ref scaffolds stop with explicit migration guidance', async () => {
		await withTempDir(async (dir) => {
			await Bun.write(join(dir, 'vozka.ref'), 'old-vozka\n')
			await Bun.write(join(dir, 'propustka.ref'), 'old-propustka\n')

			await expect(materializePlatformScaffold(dir, 'mangoweb')).rejects.toThrow(
				'Choose the matching contember/fabrika-platform commit or tag',
			)
			expect(await Bun.file(join(dir, 'vozka.ref')).text()).toBe('old-vozka\n')
			expect(await Bun.file(join(dir, 'propustka.ref')).text()).toBe('old-propustka\n')
			expect(await Bun.file(join(dir, 'README.md')).exists()).toBe(false)
			expect(await Bun.file(join(dir, 'fabrika.ref')).exists()).toBe(false)
		})
	})
})
