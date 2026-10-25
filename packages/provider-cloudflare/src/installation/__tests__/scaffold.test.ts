import { builtinEmailProviders, builtinEmailProviderVariables } from '@fabrika/email/providers'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { INITIAL_SCAFFOLD_COMMIT_MESSAGE, materializePlatformScaffold, REFRESH_SCAFFOLD_COMMIT_MESSAGE } from '../scaffold'

const GENERATED_FILES = ['.gitignore', 'README.md', 'fabrika.ref', '.github/workflows/platform.yml']
const FORBIDDEN_GENERATED_REFERENCES = [
	'contember/vozka',
	'contember/propustka',
	'vozka.ref',
	'propustka.ref',
	'packages/admin-ui',
	'packages/worker',
	'packages/engine/src/cli.ts',
	'bunx oblaka oblaka.ts --env=prod',
]

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'fabrika-cli-scaffold-'))
	try {
		await run(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

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
async function resolveBunVersion(workflow: string, bunVersionFile: string | undefined): Promise<{ exitCode: number; version: string }> {
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

async function snapshot(dir: string): Promise<Record<string, string>> {
	const entries = await Promise.all(
		GENERATED_FILES.map(async (path) => [path, await Bun.file(join(dir, path)).text()] satisfies [string, string]),
	)
	return Object.fromEntries(entries)
}

describe('platform scaffold', () => {
	test('scaffold pushes cannot deploy before init configures the Environment', () => {
		expect(INITIAL_SCAFFOLD_COMMIT_MESSAGE).toEndWith('[skip ci]')
		expect(REFRESH_SCAFFOLD_COMMIT_MESSAGE).toEndWith('[skip ci]')
	})

	test('fresh creation renders one repository checkout and one source pin offline', async () => {
		await withTempDir(async (dir) => {
			await materializePlatformScaffold(dir, 'acme')

			const files = await snapshot(dir)
			expect(files['fabrika.ref']).toBe('main\n')
			expect(files['README.md']).toContain('# fabrika-platform (acme)')
			expect(files['.github/workflows/platform.yml']).toContain('repository: contember/fabrika-platform')
			expect(files['.github/workflows/platform.yml']).toContain('working-directory: fabrika-platform/packages/iam')
			expect(files['.github/workflows/platform.yml']).toContain('working-directory: fabrika-platform/packages/operations')
			// Every stage names a platform resource, so none of them may go through `app deploy`.
			expect(files['.github/workflows/platform.yml']).not.toContain('fabrika app deploy')
			expect(files['.github/workflows/platform.yml']).toContain(
				'fabrika platform deploy --provider=cloudflare --env=prod --component-config=fabrika.config.ts',
			)
			expect(files['.github/workflows/platform.yml']).toContain('fabrika platform deploy --provider=cloudflare')
			expect(files['.github/workflows/platform.yml']).toContain('--runner-config=packages/runner-cloudflare/fabrika-runner.config.ts')
			expect(files['.github/workflows/platform.yml']).toContain('--worker-config=packages/control/fabrika.config.ts')
			const workflow = files['.github/workflows/platform.yml'] ?? ''
			expect(workflow).not.toContain('build_runner_image')
			expect(workflow).not.toContain('--build-runner-image')
			expect(workflow).toContain('id: platform')
			expect(workflow).toContain("steps.platform.outcome || 'not run'")
			expect(files['README.md']).toContain('Both paths rebuild the account-owned runner image')
			expect(workflow.indexOf('name: Deploy IAM')).toBeLessThan(workflow.indexOf('name: Deploy Operations'))
			expect(workflow.indexOf('name: Deploy Operations')).toBeLessThan(workflow.indexOf('name: Deploy fabrika runner + control plane'))
			const iamStep = workflow.slice(workflow.indexOf('name: Deploy IAM'), workflow.indexOf('name: Deploy Operations'))
			expect(iamStep).toContain('fabrika platform deploy --provider=cloudflare --env=prod --component-config=fabrika.config.ts')
			expect(iamStep).toContain('FABRIKA_IAM_SIGNING_KEYS: ${{ secrets.FABRIKA_IAM_SIGNING_KEYS }}')
			expect(iamStep).toContain('FABRIKA_IAM_PROVISIONING_KEY: ${{ secrets.FABRIKA_IAM_PROVISIONING_KEY }}')
			expect(iamStep).toContain('FABRIKA_IAM_OIDC_ENABLED: ${{ vars.FABRIKA_IAM_OIDC_ENABLED }}')
			expect(iamStep).toContain('FABRIKA_IAM_PASSWORD_ENABLED: ${{ vars.FABRIKA_IAM_PASSWORD_ENABLED }}')
			expect(iamStep).toContain('FABRIKA_EMAIL_PROVIDER: ${{ vars.FABRIKA_EMAIL_PROVIDER }}')
			expect(iamStep).toContain('FABRIKA_EMAIL_RESEND_API_KEY: ${{ secrets.FABRIKA_EMAIL_RESEND_API_KEY }}')
			// Every built-in provider's variable reaches IAM, the secret ones from the Environment's secrets.
			for (const variable of builtinEmailProviderVariables) {
				expect(iamStep).toContain(`${variable.name}: \${{ ${variable.secret ? 'secrets' : 'vars'}.${variable.name} }}`)
			}
			expect(iamStep).toContain('FABRIKA_EMAIL_FROM_NAME: ${{ vars.FABRIKA_EMAIL_FROM_NAME }}')
			// The README names every provider and its variables from the same registry, and no placeholder is left.
			for (const [name, provider] of Object.entries(builtinEmailProviders)) {
				expect(files['README.md']).toContain(`- \`${name}\`: `)
				for (const variable of provider.variables) expect(files['README.md']).toContain(`\`${variable.name}\``)
			}
			expect(`${workflow}${files['README.md']}`).not.toContain('{{EMAIL_')
			const operationsStep = workflow.slice(
				workflow.indexOf('name: Deploy Operations'),
				workflow.indexOf('name: Deploy fabrika runner + control plane'),
			)
			expect(operationsStep).toContain('FABRIKA_IAM_ISSUER: ${{ vars.FABRIKA_IAM_ISSUER }}')
			expect(operationsStep).toContain('fabrika platform deploy --provider=cloudflare --env=prod --component-config=fabrika.config.ts')
			const platformStep = workflow.slice(workflow.indexOf('name: Deploy fabrika runner + control plane'), workflow.indexOf('name: Summary'))
			// One value, one step — the step deploys both Workers, so both get the same runner key.
			expect(platformStep).toContain('FABRIKA_RUNNER_KEY: ${{ secrets.FABRIKA_RUNNER_KEY }}')
			expect(platformStep).toContain('--runner-config=packages/runner-cloudflare/fabrika-runner.config.ts')
			expect(platformStep).toContain('--worker-config=packages/control/fabrika.config.ts')
			// The control plane holds the same mail transport as IAM, to hand it to applications that send installation mail.
			for (const name of ['FABRIKA_EMAIL_PROVIDER', 'FABRIKA_EMAIL_FROM', 'FABRIKA_EMAIL_FROM_NAME']) {
				expect(platformStep).toContain(`${name}: \${{ vars.${name} }}`)
			}
			for (const variable of builtinEmailProviderVariables) {
				expect(platformStep).toContain(`${variable.name}: \${{ ${variable.secret ? 'secrets' : 'vars'}.${variable.name} }}`)
			}
			// Operations sends no mail, and nothing else in the workflow holds a mail credential.
			expect(operationsStep).not.toContain('FABRIKA_EMAIL_')
			expect(files['README.md']).toContain('hands the same set to IAM and to the control plane')
			expect(files['README.md']).toContain('FABRIKA_RUNNER_KEY')
			expect(workflow).toContain('FABRIKA_CONTROL_VAULT_KEY: ${{ secrets.FABRIKA_CONTROL_VAULT_KEY }}')
			expect(workflow).toContain('FABRIKA_CONTROL_DOMAIN: ${{ vars.FABRIKA_CONTROL_DOMAIN }}')
			expect(workflow).toContain('FABRIKA_CONTROL_BOOTSTRAP_ADMINS: ${{ vars.FABRIKA_CONTROL_BOOTSTRAP_ADMINS }}')
			expect(workflow).not.toContain('PROPUSTKA_')
			expect(workflow).not.toContain('VOZKA_')

			const generated = Object.values(files).join('\n')
			for (const forbidden of FORBIDDEN_GENERATED_REFERENCES) {
				expect(generated).not.toContain(forbidden)
			}
		})
	})

	test('the pipeline installs the Bun of the pinned checkout, never `latest`', async () => {
		await withTempDir(async (dir) => {
			await materializePlatformScaffold(dir, 'acme')
			const workflow = await Bun.file(join(dir, '.github/workflows/platform.yml')).text()

			const steps = stepsOf(workflow)
			const isSetupBun = (step: { readonly uses?: string | undefined }) => step.uses?.startsWith('oven-sh/setup-bun@') === true
			expect(steps.filter(isSetupBun).map((step) => step.with)).toEqual([{ 'bun-version': '${{ steps.bun.outputs.version }}' }])
			const checkout = steps.findIndex((step) => step.with?.['path'] === 'fabrika-platform')
			const resolve = steps.findIndex((step) => step.id === 'bun')
			expect(checkout).toBeGreaterThanOrEqual(0)
			expect(checkout).toBeLessThan(resolve)
			expect(resolve).toBeLessThan(steps.findIndex(isSetupBun))

			expect(await resolveBunVersion(workflow, '1.4.3\n')).toEqual({ exitCode: 0, version: '1.4.3' })
			// A tag up to v0.4.3 carries no `.bun-version`; every one of them was released with 1.3.14.
			expect(await resolveBunVersion(workflow, undefined)).toEqual({ exitCode: 0, version: '1.3.14' })
			expect((await resolveBunVersion(workflow, 'latest\n')).exitCode).not.toBe(0)
		})
	})

	test('unchanged refresh is byte-identical and preserves the operator pin', async () => {
		await withTempDir(async (dir) => {
			await materializePlatformScaffold(dir, 'acme')
			await Bun.write(join(dir, 'fabrika.ref'), 'v1.2.3\n')
			const before = await snapshot(dir)

			await materializePlatformScaffold(dir, 'acme')

			expect(await snapshot(dir)).toEqual(before)
		})
	})

	test('the pipeline installs exactly the pinned lockfile', async () => {
		await withTempDir(async (dir) => {
			await materializePlatformScaffold(dir, 'acme')
			const workflow = await Bun.file(join(dir, '.github/workflows/platform.yml')).text()

			const installs = stepsOf(workflow).filter((step) => step.run?.startsWith('bun install') === true)
			expect(installs.map((step) => step.run)).toEqual(['bun install --frozen-lockfile'])
		})
	})

	// Cloudflare has no `platform upgrade`: a re-run of `init` is what converges an existing sidecar's workflow.
	test('a refresh rewrites a workflow an older CLI generated and keeps the operator pin', async () => {
		await withTempDir(async (dir) => {
			await materializePlatformScaffold(dir, 'acme')
			const current = await Bun.file(join(dir, '.github/workflows/platform.yml')).text()
			const stale = current.replace('run: bun install --frozen-lockfile', 'run: bun install')
			expect(stale).not.toBe(current)
			await Bun.write(join(dir, '.github/workflows/platform.yml'), stale)
			await Bun.write(join(dir, 'fabrika.ref'), 'v0.4.3\n')

			await materializePlatformScaffold(dir, 'acme')

			expect(await Bun.file(join(dir, '.github/workflows/platform.yml')).text()).toBe(current)
			expect(await Bun.file(join(dir, 'fabrika.ref')).text()).toBe('v0.4.3\n')
		})
	})

	test('legacy two-ref scaffolds stop with explicit migration guidance', async () => {
		await withTempDir(async (dir) => {
			await Bun.write(join(dir, 'vozka.ref'), 'old-vozka\n')
			await Bun.write(join(dir, 'propustka.ref'), 'old-propustka\n')

			await expect(materializePlatformScaffold(dir, 'acme')).rejects.toThrow(
				'Choose the matching contember/fabrika-platform commit or tag',
			)
			expect(await Bun.file(join(dir, 'vozka.ref')).text()).toBe('old-vozka\n')
			expect(await Bun.file(join(dir, 'propustka.ref')).text()).toBe('old-propustka\n')
			expect(await Bun.file(join(dir, 'README.md')).exists()).toBe(false)
			expect(await Bun.file(join(dir, 'fabrika.ref')).exists()).toBe(false)
		})
	})
})
