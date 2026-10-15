import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { installationCli } from '..'
import {
	assertPinnedTag,
	defaultSidecarRepo,
	materializeSidecarScaffold,
	readPinnedTag,
	readSidecarWorkflowInstallation,
	SIDECAR_FILES,
	SIDECAR_WORKFLOW_PATH,
} from '../sidecar'

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

const workflowStepsSchema = z.object({
	jobs: z.object({
		deploy: z.object({
			steps: z.array(
				z.object({ id: z.string().optional(), uses: z.string().optional(), run: z.string().optional(), with: z.record(z.unknown()).optional() }),
			),
		}),
	}),
})

const stepsOf = (workflow: string) => workflowStepsSchema.parse(Bun.YAML.parse(workflow)).jobs.deploy.steps

/** Run the workflow's `bun` step as Actions would, in a stand-in for the pinned checkout. */
const resolveBunVersion = async (workflow: string, bunVersionFile: string | undefined): Promise<{ exitCode: number; version: string }> => {
	const step = stepsOf(workflow).find((candidate) => candidate.id === 'bun')
	if (step?.run === undefined) {
		throw new Error('the workflow has no `bun` step')
	}
	const checkout = await mkdtemp(join(tmpdir(), 'fabrika-pinned-checkout-'))
	try {
		if (bunVersionFile !== undefined) {
			await Bun.write(join(checkout, '.bun-version'), bunVersionFile)
		}
		const output = join(checkout, 'github-output')
		await Bun.write(output, '')
		const child = Bun.spawn(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
			cwd: checkout,
			env: { PATH: process.env['PATH'] ?? '', GITHUB_OUTPUT: output, PINNED_REF: 'v0.4.3' },
			stdout: 'ignore',
			stderr: 'ignore',
		})
		const exitCode = await child.exited
		const version = (await Bun.file(output).text()).match(/^version=(.*)$/m)?.[1] ?? ''
		return { exitCode, version }
	} finally {
		await rm(checkout, { recursive: true, force: true })
	}
}

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
			expect(workflow).toContain('git clone --no-checkout https://github.com/contember/fabrika-platform.git fabrika-platform')
			expect(workflow).toContain('checkout --detach "refs/tags/$PINNED_REF"')
			expect(workflow).toContain('persist-credentials: false')
			expect(workflow).toContain('--provider=zerops --source-dir=.')
			expect(workflow).toContain('steps.source.outputs.commit')
			expect(workflow).not.toContain('FABRIKA_ZEROPS_BUILD_FROM_GIT')
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
			expect(readme).toContain('uploads one exact committed')
			expect(readme).toContain('Existing namespace pins are retained when that default changes')
		})
	})

	test('the pipeline installs the Bun of the pinned tag, never `latest`', async () => {
		await withTempDir(async (dir) => {
			await materializeSidecarScaffold(dir, VALUES)
			const workflow = await workflowOf(dir)

			const steps = stepsOf(workflow)
			const setups = steps.filter((step) => step.uses?.startsWith('oven-sh/setup-bun@') === true)
			expect(setups.map((step) => step.with)).toEqual([{ 'bun-version': '${{ steps.bun.outputs.version }}' }])
			const order = (id: string) => steps.findIndex((step) => step.id === id)
			expect(order('source')).toBeLessThan(order('bun'))
			expect(order('bun')).toBeLessThan(steps.findIndex((step) => step.uses?.startsWith('oven-sh/setup-bun@') === true))

			expect(await resolveBunVersion(workflow, '1.4.3\n')).toEqual({ exitCode: 0, version: '1.4.3' })
			// A tag up to v0.4.3 carries no `.bun-version`; every one of them was released with 1.3.14.
			expect(await resolveBunVersion(workflow, undefined)).toEqual({ exitCode: 0, version: '1.3.14' })
			expect((await resolveBunVersion(workflow, 'latest\n')).exitCode).not.toBe(0)
		})
	})

	test('the installation is read back from the workflow it was rendered for', async () => {
		await withTempDir(async (dir) => {
			await materializeSidecarScaffold(dir, { ...VALUES, repo: 'contember/some-other-name' })
			expect(await readSidecarWorkflowInstallation(dir)).toBe('test')

			await Bun.write(join(dir, SIDECAR_WORKFLOW_PATH), 'name: platform\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n')
			await expect(readSidecarWorkflowInstallation(dir)).rejects.toThrow('names no `jobs.deploy.environment`')
		})
		await withTempDir(async (dir) => {
			await expect(readSidecarWorkflowInstallation(dir)).rejects.toThrow(`has no ${SIDECAR_WORKFLOW_PATH}`)
		})
	})

	test('the default repository follows the installation it deploys', () => {
		expect(defaultSidecarRepo('test')).toBe('contember/fabrika-zerops-test')
	})
})
