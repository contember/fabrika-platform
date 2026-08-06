import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installationCli } from '..'
import { assertPinnedTag, defaultSidecarRepo, materializeSidecarScaffold, readPinnedTag, SIDECAR_FILES } from '../sidecar'

const VALUES = { installation: 'test', repo: 'contember/fabrika-zerops-test', fabrikaRef: 'v0.1.0' }

/** Nothing Cloudflare's sidecar needs belongs in this one — Zerops has no runner and no GitHub App. */
const FORBIDDEN = [
	'CLOUDFLARE_API_TOKEN',
	'CLOUDFLARE_ACCOUNT_ID',
	'GITHUB_APP_PRIVATE_KEY',
	'GH_APP_ID',
	'wrangler',
	'runner image',
	'fabrika app deploy',
	'vozka.ref',
	'VOZKA_BOOTSTRAP_ADMINS',
	'BOOTSTRAP_ADMINS',
]

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
	const dir = await mkdtemp(join(tmpdir(), 'fabrika-zerops-sidecar-'))
	try {
		await run(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

const snapshot = async (dir: string): Promise<Record<string, string>> =>
	Object.fromEntries(await Promise.all(SIDECAR_FILES.map(async (path) => [path, await Bun.file(join(dir, path)).text()] satisfies [string, string])))

const workflowOf = async (dir: string): Promise<string> => await Bun.file(join(dir, '.github/workflows/platform.yml')).text()

describe('the generated Zerops sidecar repository', () => {
	test('renders one workflow, one pin, a README and a .gitignore, fully substituted', async () => {
		await withTempDir(async (dir) => {
			await materializeSidecarScaffold(dir, VALUES)
			const files = await snapshot(dir)

			expect(files['fabrika.ref']).toBe('v0.1.0\n')
			expect(files['.gitignore']).toContain('.env')
			expect(files['README.md']).toContain('# contember/fabrika-zerops-test — the test fabrika installation (Zerops)')
			// `{{` alone would match GitHub's own `${{ … }}`, so the placeholders are named.
			for (const [path, content] of Object.entries(files)) {
				for (const placeholder of ['{{INSTALLATION}}', '{{REPO}}', '{{FABRIKA_REF}}']) {
					expect(`${path} still carries ${placeholder}: ${content.includes(placeholder)}`).toEndWith('false')
				}
			}
			const generated = Object.values(files).join('\n')
			for (const forbidden of FORBIDDEN) {
				expect(generated).not.toContain(forbidden)
			}
		})
	})

	test('the pipeline calls ONE step, because on Zerops the order lives in the command (ADR-0027)', async () => {
		await withTempDir(async (dir) => {
			await materializeSidecarScaffold(dir, VALUES)
			const workflow = await workflowOf(dir)

			const calls = workflow.match(/fabrika platform deploy --provider=zerops/g) ?? []
			expect(calls).toHaveLength(1)
			expect(workflow).not.toContain('fabrika app deploy')
			expect(workflow).toContain('environment: test')
			expect(workflow).toContain('repository: contember/fabrika-platform')
			expect(workflow).toContain('ref: ${{ steps.ref.outputs.fabrika }}')
			expect(workflow).toContain('group: platform-deploy')
			expect(workflow).toContain('cancel-in-progress: false')
			expect(workflow).toContain("paths: ['fabrika.ref', '.github/workflows/platform.yml']")
		})
	})

	test('every variable the pipeline passes is one the deploy command documents', async () => {
		await withTempDir(async (dir) => {
			await materializeSidecarScaffold(dir, VALUES)
			const workflow = await workflowOf(dir)

			// The workflow is written against `platform deploy`'s usage text. Extracting the names it sets
			// and checking each against that text is what catches a rename on either side.
			const passed = [...workflow.matchAll(/^ {10}(FABRIKA_[A-Z_]+):/gm)].flatMap((match) => match[1] ?? [])
			expect(passed.length).toBeGreaterThan(0)
			for (const name of passed) {
				expect(installationCli.usage).toContain(name)
			}
			for (
				const required of ['FABRIKA_ZEROPS_ACCESS_TOKEN', 'FABRIKA_IAM_PROVISIONING_KEY', 'FABRIKA_ZEROPS_PROJECT_ID', 'FABRIKA_PLATFORM_ENVIRONMENT']
			) {
				expect(passed).toContain(required)
			}
			// Credentials are Environment SECRETS; everything else is a variable.
			expect(workflow).toContain('FABRIKA_ZEROPS_ACCESS_TOKEN: ${{ secrets.FABRIKA_ZEROPS_ACCESS_TOKEN }}')
			expect(workflow).toContain('FABRIKA_IAM_PROVISIONING_KEY: ${{ secrets.FABRIKA_IAM_PROVISIONING_KEY }}')
			expect(workflow).toContain('FABRIKA_ZEROPS_PROJECT_ID: ${{ vars.FABRIKA_ZEROPS_PROJECT_ID }}')
		})
	})

	test('the pipeline refuses a branch at run time, as init does at write time', async () => {
		await withTempDir(async (dir) => {
			await materializeSidecarScaffold(dir, VALUES)
			expect(await workflowOf(dir)).toContain('fabrika.ref must pin a published tag')

			expect(() => assertPinnedTag('main')).toThrow('is not a published tag')
			expect(() => assertPinnedTag('feature/x')).toThrow('never a branch')
			expect(() => assertPinnedTag('')).toThrow('a published fabrika tag is required')
			expect(assertPinnedTag(' v1.2.3 ')).toBe('v1.2.3')
			expect(assertPinnedTag('v0.0.1-rc.1')).toBe('v0.0.1-rc.1')
		})
	})

	test('a refresh keeps the operator-owned pin and is otherwise byte-identical', async () => {
		await withTempDir(async (dir) => {
			await materializeSidecarScaffold(dir, VALUES)
			await Bun.write(join(dir, 'fabrika.ref'), 'v9.9.9\n')
			const before = await snapshot(dir)

			await materializeSidecarScaffold(dir, VALUES)

			expect(await snapshot(dir)).toEqual(before)
			expect(await readPinnedTag(dir)).toBe('v9.9.9')
		})
	})

	test('a sidecar that drifted onto a branch is refused before anything is written', async () => {
		await withTempDir(async (dir) => {
			await Bun.write(join(dir, 'fabrika.ref'), 'main\n')

			await expect(materializeSidecarScaffold(dir, VALUES)).rejects.toThrow('is not a published tag')
			expect(await Bun.file(join(dir, 'README.md')).exists()).toBe(false)
		})
	})

	test('the README says what this repository is, and what it is not', async () => {
		await withTempDir(async (dir) => {
			await materializeSidecarScaffold(dir, VALUES)
			const readme = await Bun.file(join(dir, 'README.md')).text()

			expect(readme).toContain('This pipeline UPDATES an installation. It does not create one.')
			expect(readme).toContain('no bootstrap-admin variable')
			// The one place the pin does not reach; an operator must not infer otherwise.
			expect(readme).toContain('It does **not** decide which revision Zerops BUILDS')
		})
	})

	test('the default repository follows the installation it deploys', () => {
		expect(defaultSidecarRepo('test')).toBe('contember/fabrika-zerops-test')
	})
})
